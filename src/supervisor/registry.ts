import { Clock, DateTime, Deferred, Effect, FiberSet, FileSystem, Semaphore } from "effect";
import { buildDigest } from "../core/runs/digest";
import * as Store from "../core/runs/store";
import { computeWorktreeFields, type WorktreeFields } from "../core/runs/worktree";
import { RunConflict, RunNotFound } from "../errors";
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
  const starts = yield* Semaphore.make(1);
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
      lock: yield* Semaphore.make(1),
      calls: new Map(),
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
    if (refresh && !removed)
      run.worktree = yield* computeWorktreeFields(run.record.worktree, run.dir).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Removal can race the existence check while git or find is running.
            removed = !(yield* fs.exists(run.record.worktree));
            if (!removed) return yield* Effect.fail(error);
            return run.worktree;
          }),
        ),
      );
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
  const existing = yield* Store.readAllRuns(dataDir);
  for (const skipped of existing.skipped)
    yield* Effect.logWarning("supervisor.run.skipped", { name: skipped.name });
  for (const record of existing.runs) {
    const run = yield* add(record);
    yield* run.lock.withPermits(1)(lost(run));
  }
  const archive = Effect.fnUntraced(function* (name: RunName) {
    const run = yield* lookup(name);
    return yield* run.lock.withPermits(1)(
      Effect.gen(function* () {
        if (activeStates.has(run.record.state))
          return yield* new RunConflict({
            detail: `${name} is ${run.record.state}; active runs cannot be archived.`,
          });
        const archivePath = yield* Store.archiveRun(dataDir, name);
        runs.delete(name);
        yield* wake;
        return { _tag: "Archived" as const, name, archivePath };
      }).pipe(Effect.uninterruptible),
    );
  });
  return {
    fork: <A, E, R>(work: Effect.Effect<A, E, R>) => FiberSet.run(workers, work),
    failed: FiberSet.join(workers),
    runs,
    starts,
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
    archive,
    busy: Effect.sync(() => [...runs.values()].some((run) => activeStates.has(run.record.state))),
    change: Effect.suspend(() => Effect.succeed(Deferred.await(changed))),
  };
});
export type Registry = Effect.Success<ReturnType<typeof makeRegistry>>;
