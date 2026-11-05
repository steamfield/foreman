import { Cause, Effect, Option, Schema, Stream } from "effect";
import type { Socket } from "effect/socket";
import { type AppError, Defect, detailFor, errorClasses, failure, Usage } from "../errors";
import { defectTrace } from "../logging";
import { DaemonRequest, DaemonResponse, type DaemonResult } from "../schemas/daemon";

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
}): AppError => {
  for (const Class of errorClasses) {
    if (new Class()._tag === body.tag) return new Class({ detail: body.detail });
  }
  return new Defect();
};

export const errorResponse = (id: number, error: AppError): DaemonResponse => {
  const detail = detailFor(error);
  return { id, error: { tag: error._tag, ...(detail === undefined ? {} : { detail }) } };
};

// Pick the id from the shared request shape even when the body cannot decode.
const requestIdJson = Schema.fromJsonString(Schema.Struct({ id: DaemonRequest.fields.id }));
export const respond = Effect.fn("daemon.respond")(function* (
  line: string,
  handler: (request: DaemonRequest) => Effect.Effect<DaemonResult, AppError>,
) {
  const decoded = yield* Schema.decodeUnknownEffect(requestJson)(line).pipe(Effect.result);
  if (decoded._tag === "Failure") {
    const partial = Schema.decodeUnknownOption(requestIdJson)(line);
    return errorResponse(Option.isSome(partial) ? partial.value.id : 0, new Usage());
  }
  const request = decoded.success;
  return yield* Effect.suspend(() => handler(request)).pipe(
    Effect.map((result): DaemonResponse => ({ id: request.id, result })),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (Cause.hasDies(cause))
          yield* Effect.logError("daemon.handler.defect").pipe(
            Effect.annotateLogs({ requestId: request.id, trace: defectTrace(Cause.squash(cause)) }),
          );
        return errorResponse(request.id, failure(cause));
      }),
    ),
  );
});
