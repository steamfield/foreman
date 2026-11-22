/**
 * Run turns: start preflight and registration, follow-ups, steering, interrupts and turn
 * budgets with their hand-off. Every provider call goes through the run's connection.
 */
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Path,
  PlatformError,
  Queue,
} from "effect";
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
import { validateWorktree } from "../core/preflight/worktree";
import * as Store from "../core/runs/store";
import { validateStartMode } from "../core/start-mode";
import { detailFor, errorClasses, errorTable, PermissionDenied, RunConflict } from "../errors";
import {
  isProviderUnavailable,
  type ProviderConnection,
  type ProviderId,
  type SessionSettings,
} from "../providers/contract";
import { RpcError, RpcRequestTimeout } from "../providers/jsonrpc";
import {
  activeStates,
  type DaemonRequestBody,
  providerOf,
  type RunName,
  type RunRecord,
  type TurnKind,
} from "../schemas/daemon";
import type { Connections } from "./connections";
import { preamble, timeUp } from "./prompts";
import { turnStartSnapshot, UNSANDBOXED_READ_ONLY } from "./read-only-check";
import type { Registry, Run } from "./registry";

/** The warnings a new run starts with: the provider's own, then any about its read-only mode. */
function startWarnings(
  provider: ProviderId,
  write: boolean,
  compatibility: string | null,
  diagnostics: readonly string[],
): string[] {
  const readOnly = write ? undefined : UNSANDBOXED_READ_ONLY.get(provider);
  return [
    ...(compatibility ? [compatibility] : []),
    ...diagnostics,
    ...(readOnly === undefined ? [] : [readOnly]),
  ];
}

/** The settings a run's session and turns use, from its record. */
function sessionSettings(record: RunRecord): SessionSettings {
  return {
    cwd: record.worktree,
    model: record.model,
    effort: record.effort,
    tier: record.tier,
    access: record.sandbox === "danger-full-access" ? "write" : "read-only",
  };
}

/** The session a run's turns go to, which every run past its start has. */
function sessionOf(run: Run) {
  const session = run.record.threadId;
  if (session === null)
    return Effect.die(new Error(`Run ${run.record.name} has no session to start a turn on`));
  return Effect.succeed(session);
}

interface Preflight {
  readonly cancel: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<boolean>;
  cancelled: boolean;
}

export const makeTurns = Effect.fn("supervisor.turns")(function* (
  registry: Registry,
  connections: Connections,
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
  const path = yield* Path.Path;
  const interrupt = Effect.fnUntraced(function* (
    run: Run,
    connection: ProviderConnection,
    by: "budget" | "repo-hooks" | "orchestrator" | "monitor",
  ) {
    if (!run.record.threadId || !run.record.activeTurnId)
      return yield* new RunConflict({
        detail: `No turn is in progress for run ${run.record.name}; run foreman status ${run.record.name} before choosing the next action.`,
      });
    yield* connection.interrupt(run.record.threadId, run.record.activeTurnId);
    yield* registry.cancelQuestions(run);
    yield* registry.event(run, { _tag: "Interrupted", by });
  });
  const begin = Effect.fnUntraced(function* (
    run: Run,
    connection: ProviderConnection,
    message: string,
    kind: TurnKind,
    budgetMs: number,
  ) {
    run.projectHook = false;
    run.budgetExpired = false;
    run.budgetTurnId = null;
    run.turnSnapshot = yield* turnStartSnapshot(run.record, kind);
    const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    yield* registry.save(run, {
      turns: run.record.turns + 1,
      turnKind: kind,
      activeTurnId: null,
      turnBudgetMs: budgetMs,
      turnStartedAt: now,
      failure: null,
      restoreSandbox: kind === "handoff",
      reviewedAt: null,
    });
    yield* registry.state(run, "starting");
    const turn = yield* connection.startTurn(yield* sessionOf(run), {
      turn: run.record.turns,
      kind,
      input: message,
      settings: sessionSettings(run.record),
    });
    // The turn exists remotely even if the following persistence operation fails.
    run.record = { ...run.record, activeTurnId: turn };
    yield* registry.save(run, { activeTurnId: turn });
    yield* registry.state(run, "running");
    yield* armBudget(run, connection);
  });
  const armBudget = Effect.fnUntraced(function* (run: Run, connection: ProviderConnection) {
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
            const interrupted = yield* interrupt(run, connection, "budget").pipe(Effect.result);
            if (interrupted._tag === "Failure") {
              if (
                interrupted.failure instanceof RpcError ||
                isProviderUnavailable(interrupted.failure) ||
                interrupted.failure instanceof RpcRequestTimeout
              ) {
                const provider = yield* connections.describe(providerOf(run.record));
                yield* Effect.logWarning("supervisor.budget.interrupt.unconfirmed").pipe(
                  Effect.annotateLogs({
                    name: run.record.name,
                  }),
                );
                yield* registry.markUnknown(run);
                yield* registry.save(run, {
                  warnings: [
                    ...run.record.warnings,
                    `Budget expired for run ${run.record.name}, but ${provider.displayName} did not confirm the interrupt. Run foreman wait ${run.record.name}; execution remains unconfirmed until the run becomes inactive.`,
                  ],
                });
                return;
              }
              return yield* Effect.fail(interrupted.failure);
            }
            // The completed notification starts the hand-off, after the provider has ended the old turn.
            if (kind === "handoff") yield* registry.markUnknown(run);
          }),
        ),
      ),
      (work) => registry.background(run, work),
      registry.fork,
    );
  });
  const handoff = (run: Run, connection: ProviderConnection) =>
    begin(run, connection, timeUp, "handoff", 600_000);
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
            detail: `${run.record.name} is ${run.record.state}; run foreman wait ${run.record.name} before starting another run here.`,
          });
      }
    });
    const previous = registry.runs.get(body.name);
    yield* accepting;
    yield* available;
    if (!previous && (yield* Store.entryExists(yield* Store.runDirectory(config.home, body.name))))
      return yield* new RunConflict({
        detail: `${body.name} has unreadable run data in ${yield* Store.runDirectory(config.home, body.name)}; preserve and inspect that directory before reusing the name.`,
      });
    const providerId: ProviderId = body.provider ?? "codex";
    const prepare = Effect.gen(function* () {
      if (body.newWorktree)
        yield* createWorktree(body.worktree, body.name, body.from, (owned) => {
          created = owned;
        });
      const worktree = created?.worktree ?? body.worktree;
      if (body.setup !== undefined)
        yield* setupWorktree(
          worktree,
          body.setup,
          yield* connections.environment(providerId),
          body.budgetMs,
        );
      const validated = yield* validateWorktree(worktree, body.skipDepsCheck);
      yield* available;
      const provider = yield* connections.describe(providerId);
      const connection = yield* connections.get(providerId);
      // Inspected here first so an unreadable hooks file reports PermissionDenied; the
      // provider's trust check can only report untrusted hooks.
      yield* provider.hasRepoHooks(validated.mainCheckout, validated.worktree);
      const trust = yield* connection.hookTrust(validated.mainCheckout, validated.worktree);
      return {
        validated,
        hooksRequired: trust.required,
        model: body.model ?? (yield* provider.defaultModel),
        // A provider without service tiers records "n/a", so the digest never reads null.
        tier: body.tier ?? (provider.capabilities.serviceTier ? "priority" : "n/a"),
        warnings: startWarnings(
          providerId,
          body.write,
          yield* connections.compatibilityWarning(providerId),
          yield* connections.warnings(providerId),
        ),
      };
    });
    const { validated, hooksRequired, model, tier, warnings } = yield* Effect.raceFirst(
      prepare,
      Deferred.await(pending.cancel).pipe(Effect.as(undefined)),
    ).pipe(
      Effect.flatMap((prepared) => {
        if (prepared !== undefined) return Effect.succeed(prepared);
        pending.cancelled = true;
        return Effect.fail(
          new RunConflict({
            detail: `Start cancelled during preflight: ${body.name}. You can retry the start when ready.`,
          }),
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
        } else if (yield* Store.entryExists(yield* Store.runDirectory(config.home, body.name)))
          return yield* new RunConflict({
            detail: `${body.name} has unreadable run data in ${yield* Store.runDirectory(config.home, body.name)}; preserve and inspect that directory before reusing the name.`,
          });
        const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
        const record: RunRecord = {
          name: body.name,
          threadId: null,
          // Absent for Codex, so Codex runs stay readable by builds that predate providers.
          ...(providerId === "codex" ? {} : { provider: providerId }),
          group: validated.mainCheckout,
          worktree: validated.worktree,
          baseCommit: validated.baseCommit,
          ...(created ? { managedWorktree: created.managed } : {}),
          model,
          effort: body.effort ?? "high",
          tier,
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
          warnings,
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
        run.hooksRequired = hooksRequired;
        const connection = yield* connections.forRun(run);
        run.serverGeneration = connection.generation;
        run.retireServer = connections.retire(connection);
        const opened = yield* connection.open(run.record.name, sessionSettings(run.record));
        // Saved before anything else is sent, so the session's notifications route to the run.
        yield* registry.save(run, {
          threadId: opened.session,
          warnings: [...run.record.warnings, ...opened.warnings],
        });
        const title = `${run.record.name} (${path.basename(run.record.group)})`;
        const titleWarnings = yield* connection.nameSession(opened.session, title);
        if (titleWarnings.length > 0)
          yield* registry.save(run, { warnings: [...run.record.warnings, ...titleWarnings] });
        turnRequested = true;
        yield* begin(
          run,
          connection,
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
                const warning = `Start refused; retained ${created.worktree} (${created.managed.branch}) because execution is unconfirmed or it holds work. Run foreman status ${body.name}${activeStates.has(run.record.state) ? " and wait until the run is inactive" : ""}, then use foreman archive ${body.name} --keep-worktree to retain it.`;
                const retained = yield* registry
                  .save(run, { warnings: [...run.record.warnings, warning] })
                  .pipe(Effect.exit);
                if (retained._tag === "Failure")
                  return yield* Effect.failCause(Cause.combine(cause, retained.cause));
                if (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
                  return yield* Effect.failCause(cause);
                const error = cause.reasons.find(Cause.isFailReason)?.error;
                const provider = yield* connections.describe(providerOf(run.record));
                if (error instanceof RpcRequestTimeout)
                  return yield* Effect.fail(
                    provider.unavailable(
                      `${provider.displayName} ${error.method} timed out after ${error.timeoutMs} ms: ${warning}`,
                    ),
                  );
                for (const Class of errorClasses) {
                  if (error instanceof Class) {
                    return yield* new Class({
                      detail: `${detailFor(error) ?? errorTable[error._tag].message}\n${warning}`,
                    });
                  }
                }
                if (PlatformError.isPlatformError(error)) {
                  const detail = `${error.reason.method} (${error.reason._tag})${"pathOrDescriptor" in error.reason ? ` at ${error.reason.pathOrDescriptor}` : ""}: ${warning}`;
                  return yield* error.reason._tag === "PermissionDenied"
                    ? new PermissionDenied({ detail })
                    : new RunConflict({ detail });
                }
                if (!(error instanceof RpcError)) return yield* Effect.failCause(cause);
                return yield* new RunConflict({
                  detail: `${provider.displayName} refused the turn for run ${body.name}: ${warning}`,
                });
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
    if (run.record.state === "waiting") {
      const pending = Store.pendingQuestions(yield* Store.readQuestions(run.dir))[0];
      if (pending)
        return yield* new RunConflict({
          detail: `${run.record.name} is waiting; answer or defer ${pending.id}, or interrupt the run before sending a followup.`,
        });
    }
    if (activeStates.has(run.record.state))
      return yield* new RunConflict({
        detail: `${run.record.name} is ${run.record.state}; run foreman wait ${run.record.name} before sending a followup.`,
      });
    yield* registry.requireWorktreeAvailable(run.record.name, run.record.worktree);
    if (!(yield* fs.exists(run.record.worktree)))
      return yield* new RunConflict({
        detail: `${run.record.name}'s worktree no longer exists: ${run.record.worktree}. Prepare a worktree and start a new run.`,
      });
    if (!run.record.threadId)
      return yield* new RunConflict({
        detail: `${run.record.name} has no ${(yield* connections.describe(providerOf(run.record))).displayName} thread because its start did not create one. Start a new run with a different name; see foreman start --help.`,
      });
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
    const connection = yield* connections.forRun(run);
    run.serverGeneration = connection.generation;
    run.retireServer = connections.retire(connection);
    if (!connection.isLoaded(threadId)) {
      const resumed = yield* connection.resume(
        run.record.name,
        threadId,
        sessionSettings(run.record),
      );
      yield* registry.event(run, { _tag: "Resumed", ...resumed });
    }
    const provider = yield* connections.describe(providerOf(run.record));
    run.hooksRequired = yield* provider.hasRepoHooks(run.record.group, run.record.worktree);
    if (body.effort !== undefined) yield* registry.save(run, { effort: body.effort });
    yield* begin(run, connection, body.message, "followup", body.budgetMs ?? 3_600_000);
  });
  /**
   * Steers the active turn. Fails with the provider's SteerRefused when it won't take the
   * steer, so answer can fall back to a follow-up.
   */
  const steerOrRefuse = Effect.fnUntraced(function* (run: Run, message: string) {
    const pending = Store.pendingQuestions(yield* Store.readQuestions(run.dir))[0];
    if (pending)
      return yield* new RunConflict({
        detail: `${run.record.name} is waiting on ${pending.id}; use foreman answer ${run.record.name} ${pending.id} "<answer>" and include the change.`,
      });
    if (run.record.state !== "running" || !run.record.activeTurnId || !run.record.threadId)
      return yield* new RunConflict({
        detail: `No steerable turn is in progress for run ${run.record.name}; run foreman status ${run.record.name} before choosing the next action.`,
      });
    const connection = yield* connections.forRun(run);
    yield* connection.steer(run.record.threadId, run.record.activeTurnId, message);
    yield* registry.event(run, { _tag: "Steered", message });
  });
  /** Steers the active turn; a refused steer becomes a public RunConflict. */
  const steer = (run: Run, message: string) =>
    steerOrRefuse(run, message).pipe(
      Effect.catchTag("SteerRefused", (refused) =>
        Effect.gen(function* () {
          const provider = yield* connections.describe(providerOf(run.record));
          // Only a known protocol diagnostic can cross the public error boundary.
          const detail =
            refused.reason === "activeTurnNotSteerable"
              ? `activeTurnNotSteerable for run ${run.record.name}; wait for this turn, then send a followup.`
              : `${provider.displayName} refused the steer for run ${run.record.name}; run foreman status ${run.record.name}, then wait for the active turn before sending a followup.`;
          return yield* new RunConflict({ detail });
        }),
      ),
    );
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
    steerOrRefuse,
  };
});
export type Turns = Effect.Success<ReturnType<typeof makeTurns>>;
