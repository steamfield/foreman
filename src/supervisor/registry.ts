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
  PlatformError,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { archiveWorktree } from "../core/managed-worktree";
import {
  handoffLine,
  type QuestionCacheEntry,
  updateQuestion,
  updateTurnAttention,
} from "../core/monitor/attention";
import { buildDigest } from "../core/runs/digest";
import { contractTitle } from "../core/runs/normalize";
import { stateSince } from "../core/runs/state-since";
import * as Store from "../core/runs/store";
import { computeWorktreeFields, type WorktreeFields } from "../core/runs/worktree";
import {
  AgyUnavailable,
  CodexUnavailable,
  PermissionDenied,
  RunConflict,
  RunNotFound,
} from "../errors";
import { causeFields, redactDiagnosticText } from "../logging";
import type { QuestionCall } from "../providers/contract";
import { RpcError, RpcRequestTimeout } from "../providers/jsonrpc";
import { wordingFor } from "../providers/wording";
import {
  activeStates,
  type InterruptedBy,
  providerOf,
  type QuestionId,
  type QuestionLine,
  type RunEvent,
  type RunEventBody,
  type RunName,
  type RunRecord,
  type RunState,
} from "../schemas/daemon";
import { advancePace, countPace, emptyPace, type PaceWindow } from "./pace";

export interface SubAgentState {
  readonly threadId: string;
  readonly path: string;
  model: string | null;
  effort: string | null;
  state: "working" | "idle";
  readonly startedAt: number;
  lastInteractionAt: number;
  interactions: number;
}

export interface Run {
  version: number;
  changed: Deferred.Deferred<void>;
  record: RunRecord;
  readonly dir: string;
  readonly lock: Semaphore.Semaphore;
  /** Held question calls, each tied to the connection generation that delivered it. */
  readonly calls: Map<QuestionId, { readonly call: QuestionCall; readonly generation: symbol }>;
  /** Calls abandoned before the run held them (the latest 64), so they are dropped on arrival. */
  abandonedCalls: readonly { readonly generation: symbol; readonly callId: string }[];
  readonly messages: Queue.Queue<Effect.Effect<void, unknown>, Cause.Done>;
  readonly answers: Queue.Queue<Effect.Effect<void, unknown>, Cause.Done>;
  queuedAnswers: number;
  subagents: Map<string, SubAgentState>;
  openItem: { type: string; command: string | null; startedAt: number; id: string } | null;
  lastActivityAt: number | null;
  title: string | null;
  lastCommentary: { text: string; at: number } | null;
  stateSince: number;
  readonly questions: Map<QuestionId, QuestionCacheEntry>;
  lastHandoff: { text: string; at: number } | null;
  retrying: { at: number; message: string } | null;
  hooksBlocked: number;
  projectHook: boolean;
  hooksRequired: boolean;
  worktree: WorktreeFields | null;
  /**
   * The worktree's changed paths and their content signatures when the active turn began, kept
   * only for turns whose read-only mode the provider doesn't sandbox; null otherwise.
   */
  turnSnapshot: ReadonlyMap<string, string> | null;
  budgetExpired: boolean;
  budgetTurnId: string | null;
  serverGeneration: symbol | null;
  retireServer: Effect.Effect<void>;
  recoveryVersion: number;
  commands: { total: number; failed: number } | null;
  filesWritten: Set<string> | null;
  interruptedBy: InterruptedBy | null;
  pace: PaceWindow;
}

function countEvent(run: Run, entry: RunEvent) {
  const body = entry.event;
  if (body._tag === "Command" && body.exitCode !== null && run.commands !== null) {
    run.commands = {
      total: run.commands.total + 1,
      failed: run.commands.failed + (body.exitCode === 0 ? 0 : 1),
    };
  }
  if (body._tag === "FileChange") for (const path of body.paths) run.filesWritten?.add(path);
  if (body._tag === "Interrupted") run.interruptedBy = body.by;
  if (body._tag !== "TokenUsage" && body._tag !== "Other")
    run.pace = countPace(run.pace, DateTime.toEpochMillis(entry.at));
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
    {
      group?: string;
      reason: string;
      permissionPath?: string;
      cacheFailure?: PlatformError.PlatformError | Schema.SchemaError;
    }
  >();
  const requireWorktreeAvailable = Effect.fnUntraced(function* (name: RunName, worktree: string) {
    const reserved = reservations.get(worktree);
    if (reserved !== undefined && reserved !== name)
      return yield* new RunConflict({
        detail: `${reserved} is starting in ${worktree}; ${runs.has(reserved) ? `run foreman wait ${reserved}` : "wait for the start to finish"} before reusing this worktree.`,
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
              ? `${other.record.name} has queued answers in ${worktree}; use the cursor returned by the answer with foreman wait ${other.record.name} --after "<cursor>" before reusing this worktree.`
              : `${other.record.name} is ${other.record.state} in ${worktree}; run foreman wait ${other.record.name} before reusing this worktree.`,
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
                ? `${name} has queued answers; use the cursor returned by the answer with foreman wait ${name} --after "<cursor>" before starting another run with this name.`
                : `${name} is ${previous.record.state}; run foreman wait ${name} before starting another run with this name.`,
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
  let version = 0;
  const wake = Effect.fnUntraced(function* (run: Run) {
    version += 1;
    run.version = version;
    const runChanged = run.changed;
    run.changed = yield* Deferred.make<void>();
    const previous = changed;
    changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(runChanged, undefined);
    yield* Deferred.succeed(previous, undefined);
  }, Effect.uninterruptible);
  const add = Effect.fnUntraced(function* (record: RunRecord) {
    const dir = yield* Store.runDirectory(dataDir, record.name);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const title = yield* fs.readFileString(path.join(dir, "contract.md")).pipe(
      Effect.map(contractTitle),
      // The title is optional display metadata; an unreadable contract cannot block recovery.
      Effect.catchTag("PlatformError", () => Effect.succeed(null)),
    );
    const questions = new Map<QuestionId, QuestionCacheEntry>();
    for (const line of yield* Store.readQuestions(dir)) updateQuestion(questions, line);
    const { handoff } = yield* Store.readHandoff(dir, record.turns).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.logWarning("supervisor.handoff.unavailable").pipe(
          Effect.annotateLogs({
            name: record.name,
            ...causeFields(Cause.fail(error)),
            action:
              "Inspect the run's turns directory and file permissions; result reads saved hand-offs on demand.",
          }),
          Effect.as({ handoff: null }),
        ),
      ),
    );
    const events = yield* Store.readEvents(dir, 0, Number.MAX_SAFE_INTEGER).pipe(
      Effect.map((page) => page.events),
      // Journal corruption leaves display figures unknown without blocking transition recovery.
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning("supervisor.state-age.unavailable").pipe(
          Effect.annotateLogs({
            name: record.name,
            ...causeFields(Cause.fail(error)),
            action:
              "State age uses creation time and command/file figures are unknown; preserve and inspect events.jsonl before retrying history reads.",
          }),
          Effect.as(null),
        ),
      ),
    );
    const run: Run = {
      version,
      changed: yield* Deferred.make<void>(),
      record: {
        ...record,
        failure: Store.redactFailure(record.failure, [record.worktree, record.group, dir]),
      },
      dir,
      lock: yield* lockFor(record.name),
      calls: new Map(),
      abandonedCalls: [],
      messages: yield* Queue.unbounded<Effect.Effect<void, unknown>, Cause.Done>(),
      answers: yield* Queue.unbounded<Effect.Effect<void, unknown>, Cause.Done>(),
      queuedAnswers: 0,
      subagents: new Map(),
      openItem: null,
      lastActivityAt: null,
      title,
      lastCommentary: null,
      stateSince: DateTime.toEpochMillis(stateSince(record, events ?? [])),
      questions,
      lastHandoff:
        handoff === null
          ? null
          : handoffLine(handoff.text, DateTime.toEpochMillis(record.updatedAt)),
      retrying: null,
      hooksBlocked: 0,
      projectHook: false,
      hooksRequired: false,
      worktree: null,
      turnSnapshot: null,
      budgetExpired: false,
      budgetTurnId: null,
      serverGeneration: null,
      retireServer: Effect.void,
      recoveryVersion: 0,
      commands: events === null ? null : { total: 0, failed: 0 },
      filesWritten: events === null ? null : new Set(),
      interruptedBy: null,
      pace: emptyPace(yield* Clock.currentTimeMillis),
    };
    for (const entry of events ?? []) countEvent(run, entry);
    const previous = runs.get(record.name);
    runs.set(record.name, run);
    if (previous) yield* wake(previous);
    yield* wake(run);
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
    if (next.state !== run.record.state) run.stateSince = DateTime.toEpochMillis(next.updatedAt);
    run.record = next;
    yield* wake(run);
  });
  const event = (run: Run, body: RunEventBody) =>
    Store.appendEvent(run.dir, body).pipe(
      Effect.tap((entry) =>
        Effect.gen(function* () {
          run.pace = advancePace(run.pace, DateTime.toEpochMillis(entry.at));
          countEvent(run, entry);
          updateTurnAttention(
            run,
            body._tag === "Retrying"
              ? { ...body, message: redactDiagnosticText(body.message) }
              : body,
            DateTime.toEpochMillis(entry.at),
          );
          yield* wake(run);
        }),
      ),
    );
  const appendQuestion = Effect.fnUntraced(function* (run: Run, line: QuestionLine) {
    yield* Store.appendQuestion(run.dir, line);
    updateQuestion(
      run.questions,
      line._tag === "Asked" ? { ...line, question: redactDiagnosticText(line.question) } : line,
    );
    yield* wake(run);
  });
  const handoff = Effect.fnUntraced(function* (run: Run, text: string) {
    yield* Store.writeHandoff(run.dir, run.record.turns, text);
    run.lastHandoff = handoffLine(redactDiagnosticText(text), yield* Clock.currentTimeMillis);
    yield* wake(run);
  });
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
    if (!(yield* Store.hasTransition(run.dir, pending.id))) {
      const entry = yield* Store.appendEvent(
        run.dir,
        { _tag: "StateChanged", from: pending.from, to: pending.to },
        pending.id,
      );
      run.pace = advancePace(run.pace, DateTime.toEpochMillis(entry.at));
      countEvent(run, entry);
      run.stateSince = DateTime.toEpochMillis(entry.at);
    }
    yield* save(run, { pendingStateEvent: null });
    yield* wake(run);
  });
  const cancelQuestions = Effect.fnUntraced(function* (run: Run) {
    for (const question of Store.pendingQuestions(yield* Store.readQuestions(run.dir))) {
      yield* appendQuestion(run, {
        _tag: "Resolved",
        id: question.id,
        resolution: "cancelled",
        text: null,
        at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
      });
      const held = run.calls.get(question.id);
      run.calls.delete(question.id);
      if (held) yield* held.call.cancel;
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
        message: `${reason}. Inspect ${run.record.worktree} and ${run.dir}, then run foreman doctor before starting or resuming work.`,
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
      if (skipped?.cacheFailure) return yield* Effect.fail(skipped.cacheFailure);
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
                  yield* lost(
                    run,
                    `${wordingFor(providerOf(run.record)).server} retired after unconfirmed execution`,
                  );
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
      error instanceof RpcRequestTimeout ||
      error instanceof CodexUnavailable ||
      error instanceof AgyUnavailable;
    const next = uncertain ? "unknown" : "failed";
    const infrastructure = !(
      error instanceof RpcRequestTimeout ||
      error instanceof CodexUnavailable ||
      error instanceof AgyUnavailable ||
      error instanceof RpcError
    );
    const diagnostic = causeFields(cause);
    const patch = {
      ...(uncertain ? {} : { activeTurnId: null }),
      ...(infrastructure || !uncertain
        ? {
            failure: {
              message: `Supervisor operation failed (${diagnostic.reasonTag}${diagnostic.method ? `: ${diagnostic.method}` : ""}${diagnostic.reason ? `, ${diagnostic.reason}` : ""}) for run ${run.record.name}${diagnostic.path ? ` at ${diagnostic.path}` : ""}. Run foreman doctor and inspect ${run.dir} before retrying.`,
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
      if (run.record.state !== next) run.stateSince = yield* Clock.currentTimeMillis;
      run.record = { ...run.record, ...patch, state: next };
      yield* wake(run);
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
    const previous = run.worktree;
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
    if (JSON.stringify(previous) !== JSON.stringify(run.worktree)) yield* wake(run);
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
    yield* Effect.gen(function* () {
      const run = yield* add(record);
      yield* run.lock.withPermits(1)(publishState(run).pipe(Effect.andThen(lost(run))));
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const run = runs.get(record.name);
        runs.delete(record.name);
        const dir = path.join(dataDir, "runs", record.name);
        const diagnostic = causeFields(cause);
        const error = cause.reasons.find(Cause.isFailReason)?.error;
        skippedDirectories.set(dir, {
          group: record.group,
          // Inactive runs previously surfaced journal errors at the named request boundary.
          ...(!activeStates.has(record.state) &&
          (PlatformError.isPlatformError(error) || Schema.isSchemaError(error))
            ? { cacheFailure: error }
            : {}),
          reason: `Recovery failed (${diagnostic.reason ?? diagnostic.reasonTag}${diagnostic.method ? `: ${diagnostic.method}` : ""}).`,
          ...(diagnostic.reason === "PermissionDenied"
            ? { permissionPath: typeof diagnostic.path === "string" ? diagnostic.path : dir }
            : {}),
        });
        const cleanup =
          run === undefined
            ? Effect.void
            : Queue.end(run.messages).pipe(Effect.andThen(Queue.end(run.answers)));
        return cleanup.pipe(
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
          "Preserve and inspect this directory; restore readable data with a compatible foreman version, then restart the daemon.",
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
              detail: `${name} ${run.queuedAnswers > 0 ? "has queued answers" : `is ${run.record.state}`}; run foreman status ${name} and wait until the run is inactive and its answers are delivered before archiving.`,
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
          yield* wake(run);
          return { _tag: "Archived" as const, name, archivePath };
        }).pipe(Effect.uninterruptible),
      ),
    );
  });
  yield* FiberSet.run(
    workers,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(60_000 - (now % 60_000));
      const at = yield* Clock.currentTimeMillis;
      for (const run of runs.values()) {
        const next = advancePace(run.pace, at);
        if (next === run.pace) continue;
        run.pace = next;
        yield* wake(run);
      }
    }).pipe(Effect.forever),
  );
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
    question: appendQuestion,
    handoff,
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
    get version() {
      return version;
    },
    wake,
  };
});
/** Registry operations and the current supervised runs. */
export type Registry = Effect.Success<ReturnType<typeof makeRegistry>>;
