import { Clock, DateTime, Effect, Schema } from "effect";
import * as Store from "../core/runs/store";
import { RunConflict, RunNotFound } from "../errors";
import * as Codex from "../schemas/codex";
import { type AnswerDelivery, QuestionId } from "../schemas/daemon";
import type { AppServer } from "./app-server";
import { deferral } from "./prompts";
import type { Registry, Run } from "./registry";

export const makeQuestions = Effect.fn("supervisor.questions")(function* (registry: Registry) {
  const inspect = Effect.fnUntraced(function* (run: Run, id: QuestionId) {
    const lines = yield* Store.readQuestions(run.dir);
    const question = lines.find((line) => line._tag === "Asked" && line.id === id);
    if (question?._tag !== "Asked")
      return yield* new RunNotFound({ detail: `No question ${id}; read status for questions.` });
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
  ) {
    yield* Store.appendQuestion(run.dir, {
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
    });
  }, Effect.uninterruptible);
  const supersede = Effect.fnUntraced(function* (run: Run) {
    for (const question of Store.unansweredQuestions(yield* Store.readQuestions(run.dir)))
      yield* record(run, question.id, "superseded", null);
  });
  const resolve = Effect.fnUntraced(function* (
    run: Run,
    server: AppServer,
    id: QuestionId,
    text: string,
    resolution: "answered" | "deferred",
    by: "timeout" | "orchestrator" = "orchestrator",
    note?: string,
  ) {
    const lines = yield* Store.readQuestions(run.dir);
    if (!lines.some((line) => line._tag === "Asked" && line.id === id))
      return yield* new RunNotFound({
        detail: `No question ${id}; read status for pending questions.`,
      });
    const rpc = run.calls.get(id);
    if (
      rpc === undefined ||
      rpc.server.generation !== server.generation ||
      !Store.pendingQuestions(lines).some((q) => q.id === id)
    )
      return yield* new RunConflict({
        detail: `${id} is no longer pending; read status before answering.`,
      });
    yield* Effect.gen(function* () {
      yield* rpc.server.connection.respond(rpc.id, {
        success: true,
        contentItems: [{ type: "inputText", text }],
      });
      run.calls.delete(id);
      const at = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
      yield* Store.appendQuestion(
        run.dir,
        resolution === "deferred"
          ? { _tag: "Deferred", id, by, ...(note === undefined ? {} : { note }), at }
          : { _tag: "Resolved", id, resolution, delivery: "response", text, at },
      );
      yield* registry.event(run, { _tag: "QuestionResolved", id, resolution });
      if (run.calls.size === 0 && run.record.state === "waiting")
        yield* registry.state(run, "running");
    }).pipe(
      Effect.tapCause((cause) => registry.recover(run, cause)),
      Effect.uninterruptible,
    );
  });
  const receive = Effect.fnUntraced(function* (
    run: Run,
    server: AppServer,
    message: typeof Codex.RpcServerRequest.Type,
    params: typeof Codex.ToolCallParams.Type,
  ) {
    if (params.tool !== "ask_orchestrator")
      return yield* server.connection.respondError(message.id, -32601, "unsupported tool");
    const args = yield* Schema.decodeUnknownEffect(Codex.AskOrchestratorArguments)(
      params.arguments,
    ).pipe(Effect.result);
    if (args._tag === "Failure")
      return yield* server.connection.respondError(
        message.id,
        -32602,
        "invalid ask_orchestrator arguments",
      );
    if (
      params.turnId !== run.record.activeTurnId ||
      !["running", "waiting"].includes(run.record.state)
    )
      return yield* server.connection.respondError(message.id, -32602, "turn is no longer active");
    const lines = yield* Store.readQuestions(run.dir);
    const ids = lines
      .filter((line) => line._tag === "Asked")
      .map((line) => Number(line.id.slice(1)));
    const id = yield* Schema.decodeUnknownEffect(QuestionId)(`q${Math.max(0, ...ids) + 1}`);
    const kind = args.success.kind ?? "question";
    yield* Store.appendQuestion(run.dir, {
      _tag: "Asked",
      id,
      turn: run.record.turns,
      kind,
      question: args.success.question,
      at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    });
    run.calls.set(id, { id: message.id, server });
    yield* registry.event(run, {
      _tag: "QuestionAsked",
      id,
      kind,
      question: args.success.question,
    });
    yield* registry.state(run, "waiting");
    yield* Effect.sleep(run.record.questionTimeoutMs).pipe(
      Effect.andThen(
        run.lock.withPermits(1)(
          Effect.gen(function* () {
            if (run.calls.has(id)) yield* resolve(run, server, id, deferral, "deferred", "timeout");
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
