/**
 * Questions whose provider call ended before an answer (agy's bridge closed): cancelling the
 * held question, and remembering a call abandoned before the supervisor held it so the call
 * is dropped when it arrives.
 */
import { Clock, DateTime, Effect } from "effect";
import type { QuestionId } from "../schemas/daemon";
import type { Registry, Run } from "./registry";

/** Why an abandoned question was cancelled, for the log. */
const ABANDONED = "the agent's tool call ended before an answer";
/** How many abandoned calls a run remembers, in case their QuestionCall arrives afterwards. */
const ABANDONED_MEMORY = 64;

/**
 * Remembers a call abandoned before the run held it, keeping the latest 64. Pure bookkeeping on
 * the run.
 * @throws Never.
 */
export function rememberAbandoned(run: Run, generation: symbol, callId: string): void {
  const remembered = [...run.abandonedCalls, { generation, callId }];
  run.abandonedCalls = remembered.slice(-ABANDONED_MEMORY);
}

/**
 * Reports whether the call was abandoned before the run held it.
 * @throws Never.
 */
export function wasAbandoned(run: Run, generation: symbol, callId: string): boolean {
  return run.abandonedCalls.some(
    (entry) => entry.generation === generation && entry.callId === callId,
  );
}

/**
 * Records a held question cancelled because its call ended, and moves a waiting run with no
 * other held call back to running. Called with the run lock held.
 * @throws Never beyond the run store's own failures, which also recover the run.
 */
export const cancelEnded = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  id: QuestionId,
) {
  yield* Effect.gen(function* () {
    run.calls.delete(id);
    const at = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    yield* registry.question(run, {
      _tag: "Resolved",
      id,
      resolution: "cancelled",
      text: null,
      at,
    });
    yield* registry.event(run, { _tag: "QuestionResolved", id, resolution: "cancelled" });
    yield* Effect.logInfo("supervisor.question.abandoned").pipe(
      Effect.annotateLogs({ name: run.record.name, question: id, reason: ABANDONED }),
    );
    if (run.calls.size === 0 && run.record.state === "waiting")
      yield* registry.state(run, "running");
  }).pipe(
    Effect.tapCause((cause) => registry.recover(run, cause)),
    Effect.uninterruptible,
  );
});

/**
 * Cancels the question whose provider call `callId` (from connection `generation`) ended
 * before an answer. A later answer to it takes the late-answer path. When the run doesn't hold
 * the call yet, remembers it so `receive` drops the call. Called with the run lock held.
 * @throws Never beyond the run store's own failures.
 */
export const abandonQuestion = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  generation: symbol,
  callId: string,
) {
  const entry = [...run.calls].find(
    ([, held]) => held.call.callId === callId && held.generation === generation,
  );
  if (entry === undefined) return rememberAbandoned(run, generation, callId);
  yield* cancelEnded(registry, run, entry[0]);
});
