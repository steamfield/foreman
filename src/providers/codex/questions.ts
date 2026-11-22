/**
 * Codex `item/tool/call` server requests as the contract's `QuestionCall`s.
 *
 * `ask_orchestrator` is the only tool foreman offers Codex. Every other server request is
 * refused here with a JSON-RPC error, so the supervisor only ever sees questions.
 */
import { Effect, Result, Schema, Stream } from "effect";
import type { CodexUnavailable } from "../../errors";
import * as Codex from "../../schemas/codex";
import type { Inbound, QuestionCall } from "../contract";
import type { RpcId, RpcServerRequest } from "../jsonrpc";

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** The replies a held tool call needs; the app-server channel provides them. */
export interface QuestionReplies {
  readonly respond: (id: RpcId, result: unknown) => Effect.Effect<unknown, CodexUnavailable>;
  readonly respondError: (
    id: RpcId,
    code: number,
    message: string,
  ) => Effect.Effect<unknown, CodexUnavailable>;
}

/** A server request read as a question, or the JSON-RPC error that refuses it. */
export type ServerRequestReading =
  | { readonly _tag: "Question"; readonly call: QuestionCall }
  | { readonly _tag: "Refused"; readonly code: number; readonly message: string };

const refused = (code: number, message: string): ServerRequestReading => ({
  _tag: "Refused",
  code,
  message,
});

const decodeToolCall = Schema.decodeUnknownResult(Codex.ToolCallParams);
const decodeArguments = Schema.decodeUnknownResult(Codex.AskOrchestratorArguments);

function questionCall(
  request: RpcServerRequest,
  params: typeof Codex.ToolCallParams.Type,
  args: typeof Codex.AskOrchestratorArguments.Type,
  replies: QuestionReplies,
): QuestionCall {
  return {
    session: params.threadId,
    turn: params.turnId,
    callId: params.callId,
    question: args.question,
    kind: args.kind ?? "question",
    raw: request,
    respond: (text) =>
      replies
        .respond(request.id, { success: true, contentItems: [{ type: "inputText", text }] })
        .pipe(Effect.asVoid),
    reject: (reason) =>
      replies.respondError(request.id, INVALID_PARAMS, reason).pipe(Effect.asVoid),
    // Codex drops a held tool call itself when its turn ends, so there is nothing to send.
    cancel: Effect.void,
  };
}

/** Reads one Codex server request as an `ask_orchestrator` question, or says how to refuse it. */
export function readServerRequest(
  request: RpcServerRequest,
  replies: QuestionReplies,
): ServerRequestReading {
  if (request.method !== Codex.Method.toolCall)
    return refused(METHOD_NOT_FOUND, "unsupported method");
  const params = decodeToolCall(request.params);
  if (Result.isFailure(params)) return refused(INVALID_PARAMS, "invalid tool call");
  if (params.success.tool !== Codex.askOrchestratorTool.name)
    return refused(METHOD_NOT_FOUND, "unsupported tool");
  const args = decodeArguments(params.success.arguments);
  if (Result.isFailure(args)) return refused(INVALID_PARAMS, "invalid ask_orchestrator arguments");
  return { _tag: "Question", call: questionCall(request, params.success, args.success, replies) };
}

/**
 * Turns the channel's server requests into question calls, answering every other request
 * with its JSON-RPC error on the way. `onRefused` receives each refused request as an
 * eventless inbound message, so the run's raw log still shows it.
 */
export const questionCalls = <E>(
  requests: Stream.Stream<RpcServerRequest, E>,
  replies: QuestionReplies,
  onRefused: (inbound: Inbound) => Effect.Effect<unknown>,
): Stream.Stream<QuestionCall, E | CodexUnavailable> =>
  requests.pipe(
    Stream.filterMapEffect((request) => {
      const reading = readServerRequest(request, replies);
      if (reading._tag === "Question") return Effect.succeed(Result.succeed(reading.call));
      return onRefused({
        session: threadOf(request.params),
        method: request.method,
        raw: request,
        events: [],
      }).pipe(
        Effect.andThen(replies.respondError(request.id, reading.code, reading.message)),
        Effect.as(Result.fail(undefined)),
      );
    }),
  );

/** The thread a server request names, or null when it names none. */
function threadOf(params: unknown): string | null {
  return Schema.is(Schema.Struct({ threadId: Schema.String }))(params) ? params.threadId : null;
}
