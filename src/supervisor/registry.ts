import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  type Path,
  type PlatformError,
  Predicate,
  Queue,
  type Schema,
  Semaphore,
  Stream,
} from "effect";
import { CodexRequestTimeout, CodexRpcError } from "../codex/client";
import { archiveWorktree } from "../core/managed-worktree";
import { buildDigest } from "../core/runs/digest";
import * as Store from "../core/runs/store";
import { computeWorktreeFields, type WorktreeFields } from "../core/runs/worktree";
import { CodexUnavailable, RunConflict, RunNotFound } from "../errors";
import type { RpcId, ThreadItem } from "../schemas/codex";
import {
  activeStates,
  type QuestionId,
  type RunEventBody,
  type RunName,
  type RunRecord,
  type RunState,
} from "../schemas/daemon";

export interface Run {
  record: RunRecord;
  readonly dir: string;
  readonly lock: Semaphore.Semaphore;
  readonly calls: Map<QuestionId, RpcId>;
  readonly messages: Queue.Queue<Effect.Effect<void, unknown>, Cause.Done>;
  items: ThreadItem[];
  projectHook: boolean;
  hooksRequired: boolean;
  worktree: WorktreeFields | null;
  budgetExpired: boolean;
  budgetTurnId: string | null;
  serverGeneration: symbol | null;
  recoveryVersion: number;
}

export const makeRegistry = Effect.fn("supervisor.registry")(function* (dataDir: string) {
  const workers = yield* FiberSet.make<unknown, unknown>();
  const runs = new Map<RunName, Run>();
  const locks = new Map<RunName, Semaphore.Semaphore>();
  const lockFor = (name: RunName) =>
    Effect.sync(() => {
      let lock = locks.get(name);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(name, lock);
      }
      return lock;
    });
  const starts = yield* Semaphore.make(1);
  const reservations = new Map<string, RunName>();
  const requireWorktreeAvailable = Effect.fnUntraced(function* (name: RunName, worktree: string) {
    const reserved = reservations.get(worktree);
    if (reserved !== undefined && reserved !== name)
      return yield* new RunConflict({
        detail: `${reserved} is starting in ${worktree}; wait or interrupt it before reusing this worktree.`,
      });
    for (const other of runs.values()) {
      if (
        other.record.name !== name &&
        other.record.worktree === worktree &&
        activeStates.has(other.record.state)
      )
        return yield* new RunConflict({
          detail: `${other.record.name} is ${other.record.state} in ${worktree}; wait or interrupt it before reusing this worktree.`,
        });
    }
  });
  const reserveWorktree = (name: RunName, worktree: string) =>
    starts.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWorktreeAvailable(name, worktree);
        const previous = runs.get(name);
        if (previous && activeStates.has(previous.record.state))
          return yield* new RunConflict({
            detail: `${name} is ${previous.record.state}; wait or interrupt it first.`,
          });
        reservations.set(worktree, name);
      }),
    );
  const releaseWorktree = (name: RunName, worktree: string) =>
    starts.withPermits(1)(
      Effect.sync(() => {
        if (reservations.get(worktree) === name) reservations.delete(worktree);
      }),
    );
  let changed = yield* Deferred.make<void>();
  const wake = Effect.gen(function* () {
    const previous = changed;
    changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });
  const add = Effect.fnUntraced(function* (record: RunRecord) {
    const run: Run = {
      record,
      dir: yield* Store.runDirectory(dataDir, record.name),
      lock: yield* lockFor(record.name),
      calls: new Map(),
      messages: yield* Queue.unbounded<Effect.Effect<void, unknown>, Cause.Done>(),
      items: [],
      projectHook: false,
      hooksRequired: false,
      worktree: null,
      budgetExpired: false,
      budgetTurnId: null,
      serverGeneration: null,
      recoveryVersion: 0,
    };
    runs.set(record.name, run);
    yield* FiberSet.run(
      workers,
      Stream.fromQueue(run.messages).pipe(
        Stream.runForEach((work) => background(run, run.lock.withPermits(1)(work))),
      ),
    );
    return run;
  });
  const save = Effect.fnUntraced(function* (run: Run, patch: Partial<RunRecord>) {
    const next = {
      ...run.record,
      ...patch,
      updatedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    };
    yield* Store.writeRun(run.dir, next);
    run.record = next;
    yield* wake;
  });
  const event = (run: Run, body: RunEventBody) =>
    Store.appendEvent(run.dir, body).pipe(Effect.tap(() => wake));
  const state = Effect.fnUntraced(function* (run: Run, to: RunState) {
    const from = run.record.state;
    if (from === to) return;
    yield* save(run, { state: to });
    yield* event(run, { _tag: "StateChanged", from, to });
  });
  const cancelQuestions = Effect.fnUntraced(function* (run: Run) {
    for (const question of Store.pendingQuestions(yield* Store.readQuestions(run.dir))) {
      yield* Store.appendQuestion(run.dir, {
        _tag: "Resolved",
        id: question.id,
        resolution: "cancelled",
        text: null,
        at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
      });
      run.calls.delete(question.id);
      yield* event(run, { _tag: "QuestionResolved", id: question.id, resolution: "cancelled" });
    }
  });
  const lost = Effect.fnUntraced(function* (run: Run) {
    if (!activeStates.has(run.record.state)) return;
    yield* cancelQuestions(run);
    yield* save(run, { activeTurnId: null });
    yield* state(run, "lost");
  });
  const lookup = Effect.fnUntraced(function* (name: RunName) {
    const run = runs.get(name);
    if (!run) return yield* new RunNotFound({ detail: `No run named ${name}; start it first.` });
    return run;
  });
  const isCurrent = (run: Run) => runs.get(run.record.name) === run;
  const reasonTag = (cause: Cause.Cause<unknown>) => {
    if (Cause.hasDies(cause)) return "Defect";
    const error = cause.reasons.find(Cause.isFailReason)?.error;
    return Predicate.hasProperty(error, "_tag") && typeof error._tag === "string"
      ? error._tag
      : "Unknown";
  };
  const markUnknown = Effect.fnUntraced(function* (
    run: Run,
  ): Effect.fn.Return<
    void,
    PlatformError.PlatformError | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path
  > {
    const version = ++run.recoveryVersion;
    yield* FiberSet.run(
      workers,
      background(
        run,
        Effect.sleep("5 minutes").pipe(
          Effect.andThen(
            run.lock.withPermits(1)(
              Effect.gen(function* () {
                if (
                  isCurrent(run) &&
                  run.record.state === "unknown" &&
                  run.recoveryVersion === version
                )
                  yield* lost(run);
              }),
            ),
          ),
        ),
      ),
    );
    yield* state(run, "unknown");
  });
  // Called with the run lock. A damaged store must not let recovery fail the daemon too.
  const recover = Effect.fnUntraced(function* (
    run: Run,
    cause: Cause.Cause<unknown>,
  ): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
    if (Cause.hasInterruptsOnly(cause)) return null;
    const error = cause.reasons.find(Cause.isFailReason)?.error;
    const uncertain =
      run.record.activeTurnId !== null ||
      error instanceof CodexRequestTimeout ||
      error instanceof CodexUnavailable;
    const next = uncertain ? "unknown" : "failed";
    const infrastructure = !(
      error instanceof CodexRequestTimeout ||
      error instanceof CodexUnavailable ||
      error instanceof CodexRpcError
    );
    const patch = {
      ...(uncertain ? {} : { activeTurnId: null }),
      ...(infrastructure || !uncertain
        ? {
            failure: { message: "Supervisor operation failed", codexErrorInfo: null },
          }
        : {}),
    };
    const recovery = yield* Effect.exit(
      Effect.gen(function* () {
        // Arm before any write: a transient store failure must not disable this deadline.
        if (uncertain) {
          yield* markUnknown(run);
          yield* save(run, patch);
        } else {
          yield* cancelQuestions(run);
          yield* save(run, patch);
          yield* state(run, next);
        }
      }),
    );
    if (Exit.isFailure(recovery)) {
      run.record = { ...run.record, ...patch, state: next };
      yield* wake;
      return reasonTag(recovery.cause);
    }
    return null;
  });
  const background = <A, E, R>(
    run: Run,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path> =>
    work.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return run.lock.withPermits(1)(
          Effect.gen(function* () {
            if (!isCurrent(run)) return;
            const recoveryReason = yield* recover(run, cause);
            yield* Effect.logError("supervisor.run.failed").pipe(
              Effect.annotateLogs({
                name: run.record.name,
                reasonTag: reasonTag(cause),
                state: run.record.state,
                recoveryReason,
              }),
            );
          }),
        );
      }),
    );
  const enqueue = Effect.fnUntraced(function* <E, R>(run: Run, work: Effect.Effect<void, E, R>) {
    const context = yield* Effect.context<R>();
    yield* Queue.offer(run.messages, work.pipe(Effect.provide(context)));
  });
  const requireCurrent = Effect.fnUntraced(function* (run: Run) {
    if (!isCurrent(run))
      return yield* new RunNotFound({
        detail: `${run.record.name} was archived or replaced; read status for current runs.`,
      });
  });
  const digest = Effect.fnUntraced(function* (run: Run, refresh = false) {
    yield* requireCurrent(run);
    const fs = yield* FileSystem.FileSystem;
    let removed = !(yield* fs.exists(run.record.worktree));
    if (refresh && !removed) {
      yield* refreshWorktree(run);
      removed = !(yield* fs.exists(run.record.worktree));
    }
    return buildDigest(
      removed
        ? {
            ...run.record,
            warnings: [...run.record.warnings, `worktree removed: ${run.record.worktree}`],
          }
        : run.record,
      (yield* Store.readEvents(run.dir, 0, Number.MAX_SAFE_INTEGER)).events,
      yield* Store.readQuestions(run.dir),
      run.dir,
      yield* Clock.currentTimeMillis,
      run.worktree,
    );
  });
  const refreshWorktree = Effect.fnUntraced(function* (run: Run) {
    const fs = yield* FileSystem.FileSystem;
    run.worktree = yield* computeWorktreeFields(run.record.worktree, run.dir).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Removal can race the existence check while git or find is running.
          const removed = !(yield* fs.exists(run.record.worktree));
          if (!removed) return yield* Effect.fail(error);
          return run.worktree;
        }),
      ),
    );
  });
  const existing = yield* Store.readAllRuns(dataDir);
  for (const skipped of existing.skipped)
    yield* Effect.logWarning("supervisor.run.skipped").pipe(
      Effect.annotateLogs({ name: skipped.name }),
    );
  for (const record of existing.runs) {
    const run = yield* add(record);
    yield* run.lock
      .withPermits(1)(lost(run))
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          runs.delete(record.name);
          return Queue.end(run.messages).pipe(
            Effect.andThen(
              Effect.logWarning("supervisor.run.skipped").pipe(
                Effect.annotateLogs({ name: record.name, reasonTag: reasonTag(cause) }),
              ),
            ),
          );
        }),
      );
  }
  const archive = Effect.fnUntraced(function* (name: RunName, keepWorktree = false) {
    const run = yield* lookup(name);
    return yield* run.lock.withPermits(1)(
      starts.withPermits(1)(
        Effect.gen(function* () {
          yield* requireCurrent(run);
          if (activeStates.has(run.record.state))
            return yield* new RunConflict({
              detail: `${name} is ${run.record.state}; active runs cannot be archived.`,
            });
          if (!keepWorktree && run.record.managedWorktree) {
            yield* requireWorktreeAvailable(name, run.record.worktree);
            yield* archiveWorktree(run.record);
          }
          const archivePath = yield* Store.archiveRun(dataDir, name);
          runs.delete(name);
          yield* Queue.end(run.messages);
          yield* wake;
          return { _tag: "Archived" as const, name, archivePath };
        }).pipe(Effect.uninterruptible),
      ),
    );
  });
  return {
    fork: <A, E, R>(work: Effect.Effect<A, E, R>) => FiberSet.run(workers, work),
    failed: FiberSet.join(workers),
    runs,
    starts,
    reservations,
    reserveWorktree,
    releaseWorktree,
    requireWorktreeAvailable,
    lockFor,
    add,
    save,
    event,
    state,
    lost,
    cancelQuestions,
    lookup,
    isCurrent,
    requireCurrent,
    digest,
    refreshWorktree,
    markUnknown,
    recover,
    background,
    enqueue,
    archive,
    busy: Effect.sync(
      () =>
        reservations.size > 0 ||
        [...runs.values()].some((run) => activeStates.has(run.record.state)),
    ),
    change: Effect.suspend(() => Effect.succeed(Deferred.await(changed))),
  };
});
export type Registry = Effect.Success<ReturnType<typeof makeRegistry>>;
