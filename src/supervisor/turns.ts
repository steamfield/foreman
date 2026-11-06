import { Cause, Clock, DateTime, Deferred, Effect, FileSystem, Queue, Schema } from "effect";
import { CodexRequestTimeout, CodexRpcError } from "../codex/client";
import type { AppConfig } from "../config";
import {
  type CreatedWorktree,
  createdWorktreeHasWork,
  createWorktree,
  managedWorktreePath,
  removeCreatedWorktree,
  rollbackOnFailure,
  setupWorktree,
} from "../core/managed-worktree";
import { checkHookTrust, hasRepoHooks } from "../core/preflight/hooks";
import { defaultModel } from "../core/preflight/model";
import { validateWorktree } from "../core/preflight/worktree";
import * as Store from "../core/runs/store";
import { validateStartMode } from "../core/start-mode";
import { CodexUnavailable, RunConflict } from "../errors";
import * as Codex from "../schemas/codex";
import {
  activeStates,
  type DaemonRequestBody,
  type RunName,
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

interface Preflight {
  readonly cancel: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<boolean>;
  cancelled: boolean;
}

export const makeTurns = Effect.fn("supervisor.turns")(function* (
  registry: Registry,
  servers: AppServers,
  config: AppConfig["Service"],
) {
  const preflights = new Map<RunName, Preflight>();
  // Interrupt routing must call this before looking up a registered run or
  // taking its name lock, which Start holds until rollback has finished.
  const cancelStart = Effect.fnUntraced(function* (name: RunName) {
    const pending = preflights.get(name);
    if (!pending) return false;
    yield* Deferred.succeed(pending.cancel, undefined);
    return yield* Deferred.await(pending.done);
  });
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
  const startLocked = Effect.fnUntraced(function* (
    body: Extract<DaemonRequestBody, { _tag: "Start" }>,
    accepting: Effect.Effect<void, RunConflict>,
    destination: string,
    pending: Preflight,
  ) {
    let created: CreatedWorktree | undefined;
    const available = Effect.gen(function* () {
      for (const run of registry.runs.values()) {
        if (
          activeStates.has(run.record.state) &&
          (run.record.name === body.name || run.record.worktree === destination)
        )
          return yield* new RunConflict({
            detail: `${run.record.name} is ${run.record.state}; wait or interrupt it before starting another run here.`,
          });
      }
    });
    const previous = registry.runs.get(body.name);
    yield* accepting;
    yield* available;
    const prepare = Effect.gen(function* () {
      if (body.newWorktree)
        yield* createWorktree(body.worktree, body.name, body.from, (owned) => {
          created = owned;
        });
      const worktree = created?.worktree ?? body.worktree;
      if (body.setup !== undefined)
        yield* setupWorktree(worktree, body.setup, yield* servers.environment, body.budgetMs);
      const validated = yield* validateWorktree(worktree, body.skipDepsCheck);
      yield* available;
      yield* checkHookTrust(
        (yield* servers.get).connection,
        validated.mainCheckout,
        validated.worktree,
      );
      return {
        validated,
        model: body.model ?? (yield* defaultModel(config.codexHome)),
        warning: yield* servers.protocolWarning,
      };
    });
    const { validated, model, warning } = yield* Effect.raceFirst(
      prepare,
      Deferred.await(pending.cancel).pipe(Effect.as(undefined)),
    ).pipe(
      Effect.flatMap((prepared) => {
        if (prepared !== undefined) return Effect.succeed(prepared);
        pending.cancelled = true;
        return Effect.fail(
          new RunConflict({ detail: `Start cancelled during preflight: ${body.name}` }),
        );
      }),
      (work) => rollbackOnFailure(() => created, work),
      Effect.ensuring(
        Effect.sync(() => {
          preflights.delete(body.name);
        }),
      ),
    );
    const register = registry.starts.withPermits(1)(
      Effect.gen(function* () {
        yield* accepting;
        yield* available;
        if (registry.runs.get(body.name) !== previous)
          return yield* new RunConflict({
            detail: "Run changed during preflight; read status before retrying.",
          });
        if (previous) {
          yield* Store.archiveRun(config.home, body.name);
          registry.runs.delete(body.name);
          yield* Queue.end(previous.messages);
        } else
          yield* fs.remove(yield* Store.runDirectory(config.home, body.name), {
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
          ...(created ? { managedWorktree: created.managed } : {}),
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
        yield* Store.createRun(config.home, record, body.contract);
        return yield* registry.add(record);
      }).pipe(Effect.uninterruptible),
    );
    const run = yield* created ? rollbackOnFailure(created, register) : register;
    yield* Effect.gen(function* () {
      let turnRequested = false;
      const open = Effect.gen(function* () {
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
        turnRequested = true;
        yield* begin(
          run,
          server,
          `${preamble}\n\n${body.contract}`,
          "start",
          body.budgetMs ?? 3_600_000,
        );
      });
      yield* open.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* registry.recover(run, cause);
            if (created) {
              if (
                turnRequested &&
                (run.record.state === "unknown" || (yield* createdWorktreeHasWork(created)))
              ) {
                const warning = `Start refused; retained ${created.worktree} (${created.managed.branch}) because execution is unconfirmed or it holds work. Inspect status, then use forman archive ${body.name} --keep-worktree to retain it.`;
                yield* registry.save(run, { warnings: [...run.record.warnings, warning] });
                const error = cause.reasons.find(Cause.isFailReason)?.error;
                const reason = error instanceof Error ? error.name : "startup failure";
                return yield* new RunConflict({ detail: `${reason}: ${warning}` });
              }
              yield* removeCreatedWorktree(created);
            }
            return yield* Effect.failCause(cause);
          }).pipe(Effect.uninterruptible),
        ),
      );
    });
    return {
      _tag: "Started" as const,
      name: body.name,
      runDir: run.dir,
      ...(created ? { worktree: created.worktree, branch: created.managed.branch } : {}),
    };
  });
  const start = Effect.fnUntraced(function* (
    body: Extract<DaemonRequestBody, { _tag: "Start" }>,
    accepting: Effect.Effect<void, RunConflict>,
  ) {
    // On the wire, worktree is the source cwd in managed mode and the
    // prepared destination otherwise. Validate before discovery or reservation.
    yield* validateStartMode({ ...body, worktree: body.newWorktree ? undefined : body.worktree });
    const destination = body.newWorktree
      ? yield* managedWorktreePath(body.worktree, body.name)
      : body.worktree;
    return yield* (yield* registry.lockFor(body.name)).withPermits(1)(
      Effect.gen(function* () {
        const cancel = yield* Deferred.make<void>();
        const done = yield* Deferred.make<boolean>();
        const pending: Preflight = { cancel, done, cancelled: false };
        preflights.set(body.name, pending);
        return yield* Effect.acquireUseRelease(
          registry.reserveWorktree(body.name, destination),
          () => startLocked(body, accepting, destination, pending),
          () => registry.releaseWorktree(body.name, destination),
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              preflights.delete(body.name);
              yield* Deferred.succeed(done, pending.cancelled);
            }),
          ),
        );
      }),
    );
  });
  const reserveFollowup = Effect.fnUntraced(function* (run: Run) {
    if (activeStates.has(run.record.state))
      return yield* new RunConflict({
        detail: `${run.record.name} is ${run.record.state}; answer, steer or interrupt the active turn first.`,
      });
    yield* registry.requireWorktreeAvailable(run.record.name, run.record.worktree);
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
  return {
    start,
    cancelStart,
    reserveFollowup,
    followup,
    begin,
    armBudget,
    handoff,
    interrupt,
    steer,
  };
});
export type Turns = Effect.Success<ReturnType<typeof makeTurns>>;
