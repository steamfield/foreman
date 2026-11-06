import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Path,
  type PlatformError,
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
import { CodexUnavailable, PermissionDenied, RunConflict, RunNotFound } from "../errors";
import { causeFields } from "../logging";
import type { RpcId, ThreadItem } from "../schemas/codex";
import {
  activeStates,
  type QuestionId,
  type RunEventBody,
  type RunName,
  type RunRecord,
  type RunState,
} from "../schemas/daemon";
import type { AppServer } from "./app-server";

export interface Run {
  record: RunRecord;
  readonly dir: string;
  readonly lock: Semaphore.Semaphore;
  readonly calls: Map<QuestionId, { id: RpcId; server: AppServer }>;
  readonly messages: Queue.Queue<Effect.Effect<void, unknown>, Cause.Done>;
  readonly answers: Queue.Queue<Effect.Effect<void, unknown>, Cause.Done>;
  queuedAnswers: number;
  items: ThreadItem[];
  projectHook: boolean;
  hooksRequired: boolean;
  worktree: WorktreeFields | null;
  budgetExpired: boolean;
  budgetTurnId: string | null;
  serverGeneration: symbol | null;
  retireServer: Effect.Effect<void>;
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
  const skippedDirectories = new Map<
    string,
    { group?: string; reason: string; permissionPath?: string }
  >();
  const requireWorktreeAvailable = Effect.fnUntraced(function* (name: RunName, worktree: string) {
    const reserved = reservations.get(worktree);
    if (reserved !== undefined && reserved !== name)
      return yield* new RunConflict({
        detail: `${reserved} is starting in ${worktree}; ${runs.has(reserved) ? `run forman wait ${reserved}` : "wait for the start to finish"} before reusing this worktree.`,
      });
    for (const other of runs.values()) {
      if (
        other.record.name !== name &&
        other.record.worktree === worktree &&
        (activeStates.has(other.record.state) || other.queuedAnswers > 0)
      )
        return yield* new RunConflict({
          detail:
            other.queuedAnswers > 0
              ? `${other.record.name} has queued answers in ${worktree}; use the cursor returned by the answer with forman wait ${other.record.name} --after "<cursor>" before reusing this worktree.`
              : `${other.record.name} is ${other.record.state} in ${worktree}; run forman wait ${other.record.name} before reusing this worktree.`,
        });
    }
  });
  const reserveWorktree = (name: RunName, worktree: string) =>
    starts.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWorktreeAvailable(name, worktree);
        const previous = runs.get(name);
        if (previous && (activeStates.has(previous.record.state) || previous.queuedAnswers > 0))
          return yield* new RunConflict({
            detail:
              previous.queuedAnswers > 0
                ? `${name} has queued answers; use the cursor returned by the answer with forman wait ${name} --after "<cursor>" before starting another run with this name.`
                : `${name} is ${previous.record.state}; run forman wait ${name} before starting another run with this name.`,
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
    const dir = yield* Store.runDirectory(dataDir, record.name);
    const run: Run = {
      record: {
        ...record,
        failure: Store.redactFailure(record.failure, [record.worktree, record.group, dir]),
      },
      dir,
      lock: yield* lockFor(record.name),
      calls: new Map(),
      messages: yield* Queue.unbounded<Effect.Effect<void, unknown>, Cause.Done>(),
      answers: yield* Queue.unbounded<Effect.Effect<void, unknown>, Cause.Done>(),
      queuedAnswers: 0,
      items: [],
      projectHook: false,
      hooksRequired: false,
      worktree: null,
      budgetExpired: false,
      budgetTurnId: null,
      serverGeneration: null,
      retireServer: Effect.void,
      recoveryVersion: 0,
    };
    runs.set(record.name, run);
    skippedDirectories.delete(run.dir);
    yield* FiberSet.run(
      workers,
      Stream.fromQueue(run.messages).pipe(
        Stream.runForEach((work) => background(run, run.lock.withPermits(1)(work))),
      ),
    );
    // Continuations wait outside the notification lock, in acceptance order.
    yield* FiberSet.run(
      workers,
      Stream.fromQueue(run.answers).pipe(
        Stream.runForEach((work) =>
          background(run, work).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                run.queuedAnswers -= 1;
              }),
            ),
          ),
        ),
      ),
    );
    return run;
  });
  const save = Effect.fnUntraced(function* (run: Run, patch: Partial<RunRecord>) {
    const next = {
      ...run.record,
      ...patch,
      failure: Store.redactFailure(
        patch.failure === undefined ? run.record.failure : patch.failure,
        [patch.worktree ?? run.record.worktree, patch.group ?? run.record.group, run.dir],
      ),
      updatedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    };
    yield* Store.writeRun(run.dir, next);
    run.record = next;
    yield* wake;
  });
  const event = (run: Run, body: RunEventBody) =>
    Store.appendEvent(run.dir, body).pipe(Effect.tap(() => wake));
  // Finish the journal before interruption can release the run lock or expose the state.
  const state = Effect.fnUntraced(function* (run: Run, to: RunState) {
    yield* publishState(run);
    const from = run.record.state;
    if (from === to) return;
    yield* save(run, { state: to, pendingStateEvent: { id: crypto.randomUUID(), from, to } });
    yield* publishState(run);
  }, Effect.uninterruptible);
  const publishState = Effect.fnUntraced(function* (run: Run) {
    const pending = run.record.pendingStateEvent;
    if (!pending) return;
    if (!(yield* Store.hasTransition(run.dir, pending.id)))
      yield* Store.appendEvent(
        run.dir,
        { _tag: "StateChanged", from: pending.from, to: pending.to },
        pending.id,
      );
    yield* save(run, { pendingStateEvent: null });
    yield* wake;
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
  const lost = Effect.fnUntraced(function* (
    run: Run,
    reason = "daemon restarted before the turn ended",
  ) {
    if (!activeStates.has(run.record.state)) return;
    yield* cancelQuestions(run);
    yield* save(run, {
      activeTurnId: null,
      failure: {
        message: `${reason}. Inspect ${run.record.worktree} and ${run.dir}, then run forman doctor before starting or resuming work.`,
        codexErrorInfo: null,
      },
    });
    yield* state(run, "lost");
  });
  const lookup = Effect.fnUntraced(function* (name: RunName) {
    const run = runs.get(name);
    if (!run) {
      const dir = yield* Store.runDirectory(dataDir, name);
      if (!(yield* Store.entryExists(dir))) {
        skippedDirectories.delete(dir);
        return yield* new RunNotFound({ detail: `No run named ${name}; start it first.` });
      }
      const skipped = skippedDirectories.get(dir);
      if (skipped?.permissionPath)
        return yield* new PermissionDenied({
          detail: `Cannot load run ${name}: ${skipped.permissionPath} (${skipped.reason}). Check file and directory permissions, then restart the daemon and retry.`,
        });
      return yield* new RunConflict({
        detail: `${name} has unreadable or unsupported run data in ${dir}${skipped ? ` (${skipped.reason})` : ""}; preserve and inspect the directory before retrying.`,
      });
    }
    return run;
  });
  const isCurrent = (run: Run) => runs.get(run.record.name) === run;
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
                ) {
                  yield* run.retireServer;
                  yield* lost(run, "app server retired after unconfirmed execution");
                }
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
  ): Effect.fn.Return<
    ReturnType<typeof causeFields> | null,
    never,
    FileSystem.FileSystem | Path.Path
  > {
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
    const diagnostic = causeFields(cause);
    const patch = {
      ...(uncertain ? {} : { activeTurnId: null }),
      ...(infrastructure || !uncertain
        ? {
            failure: {
              message: `Supervisor operation failed (${diagnostic.reasonTag}${diagnostic.method ? `: ${diagnostic.method}` : ""}${diagnostic.reason ? `, ${diagnostic.reason}` : ""}) for run ${run.record.name}${diagnostic.path ? ` at ${diagnostic.path}` : ""}. Run forman doctor and inspect ${run.dir} before retrying.`,
              codexErrorInfo: null,
            },
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
      return causeFields(recovery.cause);
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
                ...causeFields(cause),
                state: run.record.state,
                recoveryReason: recoveryReason?.reasonTag ?? null,
                ...(recoveryReason
                  ? Object.fromEntries(
                      Object.entries(recoveryReason).map(([key, value]) => [
                        `recovery_${key}`,
                        value,
                      ]),
                    )
                  : {}),
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
  const enqueueAnswer = Effect.fnUntraced(function* <E, R>(
    run: Run,
    work: Effect.Effect<void, E, R>,
  ) {
    const context = yield* Effect.context<R>();
    run.queuedAnswers += 1;
    yield* Queue.offer(run.answers, work.pipe(Effect.provide(context)));
  }, Effect.uninterruptible);
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
  const path = yield* Path.Path;
  for (const skipped of existing.skipped) {
    skippedDirectories.set(path.join(dataDir, "runs", skipped.name), {
      reason: skipped.reason,
      ...(skipped.permissionPath ? { permissionPath: skipped.permissionPath } : {}),
    });
    yield* Effect.logWarning("supervisor.run.skipped").pipe(
      Effect.annotateLogs({ name: skipped.name, reason: skipped.reason }),
    );
  }
  for (const record of existing.runs) {
    const run = yield* add(record);
    yield* run.lock
      .withPermits(1)(publishState(run).pipe(Effect.andThen(lost(run))))
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          runs.delete(record.name);
          const diagnostic = causeFields(cause);
          skippedDirectories.set(run.dir, {
            group: record.group,
            reason: `Recovery failed (${diagnostic.reason ?? diagnostic.reasonTag}${diagnostic.method ? `: ${diagnostic.method}` : ""}).`,
            ...(diagnostic.reason === "PermissionDenied"
              ? { permissionPath: typeof diagnostic.path === "string" ? diagnostic.path : run.dir }
              : {}),
          });
          return Queue.end(run.messages).pipe(
            Effect.andThen(Queue.end(run.answers)),
            Effect.andThen(
              Effect.logWarning("supervisor.run.skipped").pipe(
                Effect.annotateLogs({ name: record.name, ...diagnostic }),
              ),
            ),
          );
        }),
      );
  }
  const skipped = Effect.fnUntraced(function* (group: string) {
    const fs = yield* FileSystem.FileSystem;
    const entries: { path: string; reason: string; action: string }[] = [];
    for (const [directory, skipped] of skippedDirectories) {
      if (
        !(yield* fs.lstat(directory).pipe(
          Effect.as(true),
          // An inaccessible entry still needs its recovery warning.
          Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
        ))
      ) {
        skippedDirectories.delete(directory);
        continue;
      }
      if (skipped.group !== undefined && skipped.group !== group) continue;
      entries.push({
        path: directory,
        reason: skipped.reason,
        action:
          "Preserve and inspect this directory; restore readable data with a compatible forman version, then restart the daemon.",
      });
    }
    return entries;
  });
  const archive = Effect.fnUntraced(function* (name: RunName, keepWorktree = false) {
    const run = yield* lookup(name);
    return yield* run.lock.withPermits(1)(
      starts.withPermits(1)(
        Effect.gen(function* () {
          yield* requireCurrent(run);
          if (activeStates.has(run.record.state) || run.queuedAnswers > 0)
            return yield* new RunConflict({
              detail: `${name} ${run.queuedAnswers > 0 ? "has queued answers" : `is ${run.record.state}`}; run forman status ${name} and wait until the run is inactive and its answers are delivered before archiving.`,
            });
          const cleanup = Effect.gen(function* () {
            if (!keepWorktree && run.record.managedWorktree) {
              yield* requireWorktreeAvailable(name, run.record.worktree);
              yield* archiveWorktree(run.record);
            }
          });
          const archivePath = yield* Store.archiveRun(dataDir, name, cleanup);
          runs.delete(name);
          yield* Queue.end(run.messages);
          yield* Queue.end(run.answers);
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
    skipped,
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
    enqueueAnswer,
    archive,
    busy: Effect.sync(
      () =>
        reservations.size > 0 ||
        [...runs.values()].some(
          (run) => activeStates.has(run.record.state) || run.queuedAnswers > 0,
        ),
    ),
    change: Effect.suspend(() => Effect.succeed(Deferred.await(changed))),
  };
});
export type Registry = Effect.Success<ReturnType<typeof makeRegistry>>;
