import { Cause, Effect, Option, PlatformError, Predicate, Schema, Stream } from "effect";
import type { Socket } from "effect/socket";
import { type AppError, DaemonUnavailable, detailFor, errorClasses, failure } from "../errors";
import { defectTrace } from "../logging";
import { DaemonRequest, DaemonResponse, type DaemonResult } from "../schemas/daemon";
import { Host } from "../services/host";

export const requestJson = Schema.fromJsonString(DaemonRequest);
export const responseJson = Schema.fromJsonString(DaemonResponse);

export const lines = (reader: Socket.Reader) =>
  Stream.fromPull(Effect.succeed(reader.pull)).pipe(
    Stream.map((chunk) => (typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)),
    Stream.decodeText(),
    Stream.splitLines,
  );

export const errorFromResponse = (body: {
  readonly tag: string;
  readonly detail?: string;
}): AppError | undefined => {
  for (const Class of errorClasses) {
    if (new Class()._tag === body.tag) return new Class({ detail: body.detail });
  }
  return undefined;
};

export const errorResponse = (id: number, error: AppError): DaemonResponse => {
  const detail = detailFor(error);
  return { id, error: { tag: error._tag, ...(detail === undefined ? {} : { detail }) } };
};

// Pick the id from the shared request shape even when the body cannot decode.
const requestIdJson = Schema.fromJsonString(Schema.Struct({ id: DaemonRequest.fields.id }));

const logFailure = Effect.fnUntraced(function* (
  cause: Cause.Cause<unknown>,
  request: DaemonRequest,
) {
  const unexpected = cause.reasons.find(
    (reason) =>
      Cause.isDieReason(reason) ||
      (Cause.isFailReason(reason) && !errorClasses.some((Class) => reason.error instanceof Class)),
  );
  if (unexpected === undefined || Cause.isInterruptReason(unexpected)) return;
  const error = Cause.isDieReason(unexpected) ? unexpected.defect : unexpected.error;
  const platform = PlatformError.isPlatformError(error) ? error.reason : undefined;
  const tag =
    Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : "Unknown";
  yield* Effect.logError(
    Cause.hasDies(cause) ? "daemon.handler.defect" : "daemon.handler.failed",
  ).pipe(
    Effect.annotateLogs({
      requestId: request.id,
      request: request.body._tag,
      ...("name" in request.body ? { name: request.body.name } : {}),
      reason: platform?._tag ?? tag,
      ...(platform === undefined ? {} : { method: platform.method }),
      ...(platform !== undefined && "pathOrDescriptor" in platform
        ? { path: platform.pathOrDescriptor }
        : {}),
      ...(Cause.hasDies(cause) ? { trace: defectTrace(Cause.squash(cause)) } : {}),
    }),
  );
});

export const respond = Effect.fn("daemon.respond")(function* (
  line: string,
  handler: (request: DaemonRequest) => Effect.Effect<DaemonResult, unknown>,
) {
  const decoded = yield* Schema.decodeUnknownEffect(requestJson)(line).pipe(Effect.result);
  if (decoded._tag === "Failure") {
    const partial = Schema.decodeUnknownOption(requestIdJson)(line);
    const host = yield* Host;
    return errorResponse(
      Option.isSome(partial) ? partial.value.id : 0,
      new DaemonUnavailable({
        detail: `Request not understood; daemon build ${host.build}. The command was not accepted. Run forman doctor, finish any active runs, then run forman daemon stop and retry with the same forman build for all clients.`,
      }),
    );
  }
  const request = decoded.success;
  return yield* Effect.suspend(() => handler(request)).pipe(
    Effect.map((result): DaemonResponse => ({ id: request.id, result })),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* logFailure(cause, request);
        return errorResponse(request.id, failure(cause));
      }),
    ),
  );
});
