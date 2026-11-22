/**
 * ask_orchestrator questions on a run: holding a provider's question call, answering or
 * deferring it on the connection that delivered it, recording late answers, and the question
 * timeout a new run records. abandoned-questions.ts handles calls that ended unanswered.
 */
import { Clock, DateTime, Effect, Schema } from "effect";
import * as Store from "../core/runs/store";
import { RunConflict, RunNotFound } from "../errors";
import type { ProviderId, QuestionCall } from "../providers/contract";
import { type AnswerDelivery, QuestionId } from "../schemas/daemon";
import { cancelEnded, wasAbandoned } from "./abandoned-questions";
import { deferral } from "./prompts";
import type { Registry, Run } from "./registry";

/**
 * How long agy 1.5.14 keeps an ask_orchestrator MCP call open: measured at 180 s, after which
 * it cancels the call ("context deadline exceeded") and the model carries on.
 */
const AGY_HOLD_MS = 180_000;
/** agy questions are deferred 80 seconds before the hold ends, so the deferral still lands. */
const AGY_CAP_MS = AGY_HOLD_MS - 80_000;

const seconds = (ms: number) => `${Math.round(ms / 1000)} seconds`;

/**
 * The question timeout a new run records: the requested one (or `defaultMs`), capped below
 * agy's MCP hold for agy runs. Warns only when an explicitly requested timeout was cut. Pure.
 * @throws Never.
 */
export function questionTimeout(
  provider: ProviderId,
  requestedMs: number | undefined,
  defaultMs: number,
): { readonly timeoutMs: number; readonly warning: string | null } {
  const wantedMs = requestedMs ?? defaultMs;
  if (provider !== "agy" || wantedMs <= AGY_CAP_MS) return { timeoutMs: wantedMs, warning: null };
  const warning =
    requestedMs === undefined
      ? null
      : `agy holds a question for at most ${seconds(AGY_HOLD_MS)}; deferring after ${seconds(AGY_CAP_MS)}.`;
  return { timeoutMs: AGY_CAP_MS, warning };
}

/** Builds the question operations over the registry's runs. */
export const makeQuestions = Effect.fn("supervisor.questions")(function* (registry: Registry) {
  const inspect = Effect.fnUntraced(function* (run: Run, id: QuestionId) {
    const lines = yield* Store.readQuestions(run.dir);
    const question = lines.find((line) => line._tag === "Asked" && line.id === id);
    if (question?._tag !== "Asked")
      return yield* new RunNotFound({
        detail: `No question ${id} in run ${run.record.name}; run foreman status ${run.record.name} to see its questions.`,
      });
    const pending = Store.pendingQuestions(lines);
    const open = pending.some((question) => question.id === id);
    const previous = lines.findLast((line) => line.id === id);
    const correction =
      previous?._tag === "Resolved" &&
      ["answered", "late", "correction"].includes(previous.resolution);
    return {
      question,
      pending,
      open,
      correction,
      state: previous?._tag === "Resolved" ? previous.resolution : previous?._tag.toLowerCase(),
    };
  });
  const record = Effect.fnUntraced(function* (
    run: Run,
    id: QuestionId,
    resolution: "late" | "correction" | "superseded",
    text: string | null,
    delivery?: AnswerDelivery,
    continuation?: { readonly id: string; readonly turn: number },
    source?: "monitor",
  ) {
    yield* registry.question(run, {
      _tag: "Resolved",
      id,
      resolution,
      text,
      ...(delivery === undefined ? {} : { delivery }),
      at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    });
    yield* registry.event(run, {
      _tag: "QuestionResolved",
      id,
      resolution,
      ...(continuation === undefined ? {} : { continuation }),
      ...(source === undefined ? {} : { source }),
    });
  }, Effect.uninterruptible);
  const supersede = Effect.fnUntraced(function* (run: Run) {
    for (const question of Store.unansweredQuestions(yield* Store.readQuestions(run.dir)))
      yield* record(run, question.id, "superseded", null);
  });
  /**
   * Answers a held question through the connection generation that delivered it, then
   * records the resolution. Called with the run lock held.
   * @throws {RunNotFound} When the run never asked the question.
   * @throws {RunConflict} When the question is no longer pending, was delivered by an earlier
   * connection, or its call ended before the answer (the question is then cancelled; a timeout
   * deferral just records that).
   */
  const resolve = Effect.fnUntraced(function* (
    run: Run,
    generation: symbol,
    id: QuestionId,
    text: string,
    resolution: "answered" | "deferred",
    by: "timeout" | "orchestrator" = "orchestrator",
    note?: string,
    source?: "monitor",
  ) {
    const lines = yield* Store.readQuestions(run.dir);
    if (!lines.some((line) => line._tag === "Asked" && line.id === id))
      return yield* new RunNotFound({
        detail: `No question ${id} in run ${run.record.name}; run foreman status ${run.record.name} to see its questions.`,
      });
    const held = run.calls.get(id);
    if (
      held === undefined ||
      held.generation !== generation ||
      !Store.pendingQuestions(lines).some((q) => q.id === id)
    )
      return yield* new RunConflict({
        detail: `${id} in run ${run.record.name} is no longer pending; run foreman status ${run.record.name} before retrying.`,
      });
    const delivered = yield* Effect.gen(function* () {
      const sent = yield* held.call.respond(text).pipe(
        Effect.as(true),
        Effect.catchTag("QuestionCallEnded", () => Effect.succeed(false)),
      );
      if (!sent) return false;
      run.calls.delete(id);
      const at = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
      yield* registry.question(
        run,
        resolution === "deferred"
          ? { _tag: "Deferred", id, by, ...(note === undefined ? {} : { note }), at }
          : { _tag: "Resolved", id, resolution, delivery: "response", text, at },
      );
      yield* registry.event(run, {
        _tag: "QuestionResolved",
        id,
        resolution,
        ...(source === undefined ? {} : { source }),
      });
      if (run.calls.size === 0 && run.record.state === "waiting")
        yield* registry.state(run, "running");
      return true;
    }).pipe(
      Effect.tapCause((cause) => registry.recover(run, cause)),
      Effect.uninterruptible,
    );
    if (delivered) return;
    yield* cancelEnded(registry, run, id);
    if (by === "timeout") return;
    return yield* new RunConflict({
      detail: `${id} in run ${run.record.name} was cancelled: the agent's tool call ended before the answer arrived, so nothing was delivered. Run foreman answer ${run.record.name} ${id} "<answer>" again to send it as a late answer.`,
    });
  });
  /**
   * Holds a question call for the run and marks it waiting, or rejects the call when its
   * turn is no longer the active one. A call abandoned before it arrived is dropped. Called
   * with the run lock held.
   */
  const receive = Effect.fnUntraced(function* (run: Run, generation: symbol, call: QuestionCall) {
    if (wasAbandoned(run, generation, call.callId))
      return yield* Effect.logDebug("supervisor.question.abandonedEarly").pipe(
        Effect.annotateLogs({ name: run.record.name, callId: call.callId }),
      );
    if (call.turn !== run.record.activeTurnId || !["running", "waiting"].includes(run.record.state))
      return yield* call.reject("turn is no longer active").pipe(
        // The asker already left, so there is nobody to refuse.
        Effect.catchTag("QuestionCallEnded", () => Effect.void),
      );
    const lines = yield* Store.readQuestions(run.dir);
    const ids = lines
      .filter((line) => line._tag === "Asked")
      .map((line) => Number(line.id.slice(1)));
    const id = yield* Schema.decodeUnknownEffect(QuestionId)(`q${Math.max(0, ...ids) + 1}`);
    yield* registry.question(run, {
      _tag: "Asked",
      id,
      turn: run.record.turns,
      kind: call.kind,
      question: call.question,
      at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    });
    run.calls.set(id, { call, generation });
    yield* registry.event(run, {
      _tag: "QuestionAsked",
      id,
      kind: call.kind,
      question: call.question,
    });
    yield* registry.state(run, "waiting");
    yield* Effect.sleep(run.record.questionTimeoutMs).pipe(
      Effect.andThen(
        run.lock.withPermits(1)(
          Effect.gen(function* () {
            if (run.calls.has(id))
              yield* resolve(run, generation, id, deferral, "deferred", "timeout");
          }),
        ),
      ),
      (work) => registry.background(run, work),
      registry.fork,
    );
  });
  return { resolve, receive, inspect, record, supersede };
});
export type Questions = Effect.Success<ReturnType<typeof makeQuestions>>;
