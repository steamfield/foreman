/**
 * Answers the requests agy sends foreman: permission requests by the policy in
 * permissions.ts, everything else (fs/*, terminal/*) with method not found. Each request is
 * logged to the run's raw log, and a permission's outcome becomes a Permission event and, when
 * refused, the failure of the turn agy then ends.
 */
import { Cause, Effect, Queue, Schema } from "effect";
import * as Acp from "../../schemas/acp";
import type { RpcServerRequest } from "../jsonrpc";
import { sessionOf } from "./events";
import type { Live } from "./live";
import { decidePermission, pickOption, refusalMessage } from "./permissions";
import { activeTurn, recordRefusal } from "./turns";

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** The refusal when foreman meant to allow a tool but agy offered no one-time allow. */
export const noAllowMessage = (title: string, kind: string) =>
  `agy offered no allow_once option for ${title} (${kind}), so foreman refused it; check the agy version with foreman doctor.`;

/**
 * Answers one request from agy. A request foreman fails to answer is logged with its method
 * and id and answered with an internal error, so the next request is still answered.
 */
export const answerServerRequest = (live: Live, request: RpcServerRequest) =>
  answer(live, request).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : answerFailed(live, request, cause),
    ),
  );

const answerFailed = (live: Live, request: RpcServerRequest, cause: Cause.Cause<unknown>) =>
  Effect.logError("foreman could not answer an agy request", cause).pipe(
    Effect.annotateLogs({ method: request.method, id: String(request.id) }),
    Effect.andThen(
      // Fails only when the channel has ended, which `termination` already reports.
      live.channel
        .respondError(request.id, INTERNAL_ERROR, "foreman could not answer")
        .pipe(Effect.ignore),
    ),
  );

const answer = Effect.fnUntraced(function* (live: Live, request: RpcServerRequest) {
  if (request.method !== Acp.Method.requestPermission) {
    yield* logUnrouted(live, request);
    return yield* live.channel.respondError(request.id, METHOD_NOT_FOUND, "unsupported method");
  }
  if (!Schema.is(Acp.PermissionRequest)(request.params)) {
    yield* logUnrouted(live, request);
    const detail = `invalid ${request.method} params`;
    return yield* live.channel.respondError(request.id, INVALID_PARAMS, detail);
  }
  const optionId = yield* decide(live, request, request.params);
  yield* live.channel.respond(request.id, {
    outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
  });
});

/** Records a request that changes no run, so only the raw log shows it. */
const logUnrouted = (live: Live, request: RpcServerRequest) =>
  Queue.offer(live.inbound, {
    session: sessionOf(request.params),
    method: request.method,
    raw: request,
    events: [],
  });

/**
 * Picks the option to answer a permission request with, or null for none. For a session this
 * connection opened, reports what was sent as a Permission event and records a refusal as the
 * turn's failure.
 */
const decide = Effect.fnUntraced(function* (
  live: Live,
  request: RpcServerRequest,
  params: Acp.PermissionRequest,
) {
  const { sessionId, toolCall, options } = params;
  const state = live.sessions.get(sessionId);
  const kind = toolCall.kind ?? "other";
  const title = toolCall.title ?? toolCall.name ?? kind;
  const turnKind = state?.turn.turnKind ?? "start";
  const policy = decidePermission({
    kind,
    name: toolCall.name ?? null,
    access: state?.turn.access ?? "read-only",
    turnKind,
    known: state !== undefined,
  });
  const optionId = pickOption(options, policy);
  if (state === undefined) {
    yield* logUnrouted(live, request);
    return optionId;
  }
  const chosen = options.find((option) => option.optionId === optionId);
  const decision = chosen?.kind.startsWith("allow_") ? "approved" : "rejected";
  if (decision === "rejected") {
    const refusal =
      policy === "rejected" ? refusalMessage(title, kind, turnKind) : noAllowMessage(title, kind);
    live.sessions.set(sessionId, { ...state, turn: recordRefusal(state.turn, refusal) });
  }
  const turn = activeTurn(state.turn);
  yield* Queue.offer(live.inbound, {
    session: sessionId,
    method: request.method,
    raw: request,
    events: turn === null ? [] : [{ _tag: "Permission", turn, kind, title, decision }],
  });
  return optionId;
});
