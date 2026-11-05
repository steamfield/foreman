import { Effect, FileSystem, Path, Schema } from "effect";
import { PermissionDenied, Usage } from "../errors";
import { DurationText, Milliseconds } from "../schemas/commands";

export const durationMs = Effect.fnUntraced(function* (text: string) {
  yield* Schema.decodeUnknownEffect(DurationText)(text).pipe(Effect.mapError(() => new Usage()));
  const amount = Number.parseInt(text, 10);
  let multiplier = 1;
  if (text.endsWith("h")) multiplier = 3_600_000;
  else if (text.endsWith("m")) multiplier = 60_000;
  else if (!text.endsWith("ms")) multiplier = 1000;
  return yield* Schema.decodeUnknownEffect(Milliseconds)(amount * multiplier).pipe(
    Effect.mapError(() => new Usage()),
  );
});

export const realPath = Effect.fnUntraced(function* (value: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .realPath(path.resolve(value))
    .pipe(Effect.mapError(() => new PermissionDenied()));
});

export const readText = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(yield* realPath(file))
    .pipe(Effect.mapError(() => new PermissionDenied()));
});

export interface MessageInput {
  readonly message: string | undefined;
  readonly file: string | undefined;
}

export const messageText = Effect.fnUntraced(function* ({ message, file }: MessageInput) {
  if ((message === undefined) === (file === undefined)) return yield* new Usage();
  if (file !== undefined) return yield* readText(file);
  if (message !== undefined) return message;
  return yield* new Usage();
});
