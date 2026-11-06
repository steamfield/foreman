import { Effect, FileSystem, Path, type PlatformError, Schema } from "effect";
import { PermissionDenied, Usage, WorktreeInvalid } from "../errors";
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

const inputError = (file: string, error: PlatformError.PlatformError) =>
  error.reason._tag === "PermissionDenied"
    ? new PermissionDenied()
    : new WorktreeInvalid({
        detail:
          error.reason._tag === "NotFound"
            ? `Input not found: ${file}`
            : `Could not read input: ${file} (${error.reason._tag})`,
      });

export const realPath = Effect.fnUntraced(function* (value: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(value);
  return yield* fs.realPath(file).pipe(Effect.mapError((error) => inputError(file, error)));
});

export const readText = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(yield* realPath(file))
    .pipe(Effect.mapError((error) => inputError(file, error)));
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
