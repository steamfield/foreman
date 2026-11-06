import { Clock, DateTime, Effect, FileSystem, Queue, Schema } from "effect";
import { CodexRequestTimeout, CodexRpcError } from "../codex/client";
import type { AppConfig } from "../config";
import { checkHookTrust, hasRepoHooks } from "../core/preflight/hooks";
import { defaultModel } from "../core/preflight/model";
import { validateWorktree } from "../core/preflight/worktree";
import * as Store from "../core/runs/store";
import { CodexUnavailable, RunConflict } from "../errors";
import * as Codex from "../schemas/codex";
import {
  activeStates,
  type DaemonRequestBody,
  type RunRecord,
  type TurnKind,
} from "../schemas/daemon";
import type { AppServer, AppServers } from "./app-server";
import { preamble, timeUp } from "./prompts";
import type { Registry, Run } from "./registry";

const policy = (sandbox: RunRecord["sandbox"]) =>
  sandbox === "danger-full-access"
    ? { type: "dangerFullAccess" }
    : { type: "readOnly", networkAccess: false };

export const makeTurns = Effect.fn("supervisor.turns")(function* (
  registry: Registry,
  servers: AppServers,
  config: AppConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const settings = (run: Run) => ({
    cwd: run.record.worktree,
    model: run.record.model,
    serviceTier: run.record.tier,
    approvalPolicy: "never",
    sandbox: run.record.sandbox,
  });
  const interrupt = Effect.fnUntraced(function* (
    run: Run,
    server: AppServer,
    by: "budget" | "repo-hooks" | "orchestrator",
  ) {
    if (!run.record.threadId || !run.record.activeTurnId)
      return yield* new RunConflict({ detail: "No turn in progress; send a followup instead." });
    yield* server.connection.request(
      Codex.Method.turnInterrupt,
      { threadId: run.record.threadId, turnId: run.record.activeTurnId },
      Schema.Unknown,
    );
    yield* registry.cancelQuestions(run);
    yield* registry.event(run, { _tag: "Interrupted", by });
  });
  const begin = Effect.fnUntraced(function* (
    run: Run,
    server: AppServer,
    message: string,
    kind: TurnKind,
    budgetMs: number,
  ) {
    run.items = [];
    run.projectHook = false;
    run.budgetExpired = false;
    run.budgetTurnId = null;
    const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    yield* registry.save(run, {
      turns: run.record.turns + 1,
      turnKind: kind,
      activeTurnId: null,
      turnBudgetMs: budgetMs,
      turnStartedAt: now,
      failure: null,
      restoreSandbox: kind === "handoff",
    });
    yield* registry.state(run, "starting");
    const response = yield* server.connection.request(
      Codex.Method.turnStart,
      {
        threadId: run.record.threadId,
        input: [{ type: "text", text: message }],
        effort: run.record.effort,
        sandboxPolicy: policy(kind === "handoff" ? "read-only" : run.record.sandbox),
      },
      Codex.TurnStartResponse,
    );
    yield* registry.save(run, { activeTurnId: response.turn.id });
    yield* registry.state(run, "running");
    yield* armBudget(run, server);
  });
  const armBudget = Effect.fnUntraced(function* (run: Run, server: AppServer) {
    const turnId = run.record.activeTurnId;
    if (!turnId || run.budgetTurnId === turnId) return;
    run.budgetTurnId = turnId;
    const kind = run.record.turnKind;
    const startedAt = run.record.turnStartedAt;
    const elapsed = startedAt
      ? (yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(startedAt)
      : 0;
    const remaining = Math.max(0, (run.record.turnBudgetMs ?? 3_600_000) - elapsed);
    yield* Effect.sleep(remaining).pipe(
      Effect.andThen(
        run.lock.withPermits(1)(
          Effect.gen(function* () {
            if (run.record.activeTurnId !== turnId || !activeStates.has(run.record.state)) return;
            run.budgetExpired = kind !== "handoff";
            const interrupted = yield* interrupt(run, server, "budget").pipe(Effect.result);
            if (interrupted._tag === "Failure") {
              if (
                interrupted.failure instanceof CodexRpcError ||
                interrupted.failure instanceof CodexUnavailable ||
                interrupted.failure instanceof CodexRequestTimeout
              ) {
                yield* Effect.logWarning("supervisor.budget.interrupt.unconfirmed").pipe(
                  Effect.annotateLogs({
                    name: run.record.name,
                  }),
                );
                yield* registry.markUnknown(run);
                return;
              }
              return yield* Effect.fail(interrupted.failure);
            }
            // The completed notification starts the hand-off, after Codex has ended the old turn.
            if (kind === "handoff") {
              yield* registry.save(run, { activeTurnId: null });
              yield* registry.state(run, "interrupted");
            }
          }),
        ),
      ),
      (work) => registry.background(run, work),
      registry.fork,
    );
  });
  const handoff = (run: Run, server: AppServer) => begin(run, server, timeUp, "handoff", 600_000);
  const start = Effect.fnUntraced(function* (
    body: Extract<DaemonRequestBody, { _tag: "Start" }>,
    accepting: Effect.Effect<void, RunConflict>,
  ) {
    const available = Effect.gen(function* () {
      for (const run of registry.runs.values()) {
        if (
          activeStates.has(run.record.state) &&
          (run.record.name === body.name || run.record.worktree === body.worktree)
        )
          return yield* new RunConflict({
            detail: `${run.record.name} is ${run.record.state}; wait or interrupt it before starting another run here.`,
          });
      }
    });
    yield* available;
    const validated = yield* validateWorktree(body.worktree, body.skipDepsCheck);
    yield* checkHookTrust(
      (yield* servers.get).connection,
      validated.mainCheckout,
      validated.worktree,
    );
    const model = body.model ?? (yield* defaultModel(config.codexHome));
    const warning = yield* servers.protocolWarning;
    const previous = registry.runs.get(body.name);
    const register = registry.starts.withPermits(1)(
      Effect.gen(function* () {
        yield* accepting;
        yield* available;
        if (registry.runs.get(body.name) !== previous)
          return yield* new RunConflict({
            detail: "Run changed during preflight; read status before retrying.",
          });
        if (previous) {
          yield* Store.archiveRun(config.dataDir, body.name);
          registry.runs.delete(body.name);
          yield* Queue.end(previous.messages);
        } else
          yield* fs.remove(yield* Store.runDirectory(config.dataDir, body.name), {
            recursive: true,
            force: true,
          });
        const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
        const record: RunRecord = {
          name: body.name,
          threadId: null,
          group: validated.mainCheckout,
          worktree: validated.worktree,
          baseCommit: validated.baseCommit,
          model,
          effort: body.effort ?? "high",
          tier: body.tier ?? "priority",
          sandbox: body.write ? "danger-full-access" : "read-only",
          questionTimeoutMs: body.questionTimeoutMs ?? 900_000,
          state: "starting",
          turns: 0,
          turnKind: null,
          activeTurnId: null,
          turnBudgetMs: null,
          turnStartedAt: null,
          restoreSandbox: false,
          tokens: null,
          failure: null,
          warnings: warning ? [warning] : [],
          createdAt: now,
          updatedAt: now,
        };
        yield* Store.createRun(config.dataDir, record, body.contract);
        return yield* registry.add(record);
      }).pipe(Effect.uninterruptible),
    );
    const run = yield* previous ? previous.lock.withPermits(1)(register) : register;
    yield* run.lock.withPermits(1)(
      Effect.gen(function* () {
        run.hooksRequired = yield* hasRepoHooks(run.record.group);
        const server = yield* servers.get;
        run.serverGeneration = server.generation;
        const opened = yield* server.connection.request(
          Codex.Method.threadStart,
          {
            ...settings(run),
            ephemeral: false,
            dynamicTools: [Codex.askOrchestratorTool],
          },
          Codex.ThreadOpened,
          { timeout: "180 seconds" },
        );
        yield* registry.save(run, { threadId: opened.thread.id });
        server.loaded.add(opened.thread.id);
        yield* begin(
          run,
          server,
          `${preamble}\n\n${body.contract}`,
          "start",
          body.budgetMs ?? 3_600_000,
        );
      }).pipe(Effect.tapCause((cause) => registry.recover(run, cause))),
    );
    return { _tag: "Started" as const, name: body.name, runDir: run.dir };
  });
  const reserveFollowup = Effect.fnUntraced(function* (run: Run) {
    if (activeStates.has(run.record.state))
      return yield* new RunConflict({
        detail: `${run.record.name} is ${run.record.state}; answer, steer or interrupt the active turn first.`,
      });
    for (const other of registry.runs.values()) {
      if (
        other !== run &&
        other.record.worktree === run.record.worktree &&
        activeStates.has(other.record.state)
      )
        return yield* new RunConflict({
          detail: `${other.record.name} is active in this worktree; wait or interrupt it first.`,
        });
    }
    if (!(yield* fs.exists(run.record.worktree)))
      return yield* new RunConflict({
        detail: "Worktree no longer exists; prepare a worktree and start a new run.",
      });
    if (!run.record.threadId)
      return yield* new RunConflict({ detail: "No thread was created; start a new run instead." });
    yield* registry
      .state(run, "starting")
      .pipe(Effect.tapCause((cause) => registry.recover(run, cause)));
    return run.record.threadId;
  });
  const followup = Effect.fnUntraced(function* (
    run: Run,
    body: Extract<DaemonRequestBody, { _tag: "Followup" }>,
    threadId: string,
  ) {
    const server = yield* servers.get;
    run.serverGeneration = server.generation;
    if (!server.loaded.has(threadId)) {
      const resumed = yield* server.connection.request(
        Codex.Method.threadResume,
        { threadId, ...settings(run) },
        Codex.ThreadOpened,
      );
      server.loaded.add(threadId);
      yield* registry.event(run, {
        _tag: "Resumed",
        sandbox: resumed.sandbox.type,
        model: resumed.model,
      });
    }
    run.hooksRequired = yield* hasRepoHooks(run.record.group);
    if (body.effort !== undefined) yield* registry.save(run, { effort: body.effort });
    yield* begin(run, server, body.message, "followup", body.budgetMs ?? 3_600_000);
  });
  const steer = Effect.fnUntraced(function* (run: Run, message: string) {
    const pending = Store.pendingQuestions(yield* Store.readQuestions(run.dir))[0];
    if (pending)
      return yield* new RunConflict({
        detail: `answer ${pending.id} first; the answer can carry the change`,
      });
    if (run.record.state !== "running" || !run.record.activeTurnId)
      return yield* new RunConflict({
        detail: "No steerable turn in progress; send a followup instead.",
      });
    const server = yield* servers.get;
    yield* server.connection
      .request(
        Codex.Method.turnSteer,
        {
          threadId: run.record.threadId,
          expectedTurnId: run.record.activeTurnId,
          input: [{ type: "text", text: message }],
        },
        Codex.TurnSteerResponse,
      )
      .pipe(
        Effect.catchTag("CodexRpcError", (error) => {
          // Only a known protocol diagnostic can cross the public error boundary.
          const detail =
            error instanceof CodexRpcError && error.message === "activeTurnNotSteerable"
              ? "activeTurnNotSteerable; wait for this turn, then send a followup."
              : "Codex refused the steer; read status, then retry or send a followup.";
          return Effect.fail(new RunConflict({ detail }));
        }),
      );
    yield* registry.event(run, { _tag: "Steered", message });
  });
  return { start, reserveFollowup, followup, begin, armBudget, handoff, interrupt, steer };
});
export type Turns = Effect.Success<ReturnType<typeof makeTurns>>;
