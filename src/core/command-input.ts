import { Effect, FileSystem, Path, type PlatformError, Schema } from "effect";
import { InputError, PermissionDenied, Usage, WorktreeInvalid } from "../errors";
import { DurationText, Milliseconds } from "../schemas/commands";

// Effect's lexer treats negative durations such as -1s as clustered short flags.
export function normalizeDurationArgs(args: readonly string[]): string[] {
  const argv = [...args];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--") break;
    const value = argv[index + 1];
    if (
      (flag === "--timeout" || flag === "--budget" || flag === "--question-timeout") &&
      value !== undefined &&
      /^-\d/.test(value)
    )
      argv.splice(index, 2, `${flag}=${value}`);
  }
  return argv;
}

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
    ? new PermissionDenied({
        detail: `Cannot resolve ${file}. Check directory permissions and retry.`,
      })
    : new WorktreeInvalid({
        detail:
          error.reason._tag === "NotFound"
            ? `Input not found: ${file}. Create it or correct the path and retry.`
            : `Could not resolve input: ${file} (${error.reason._tag}). Check the path and retry.`,
      });

export const realPath = Effect.fnUntraced(function* (value: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(value);
  return yield* fs.realPath(file).pipe(Effect.mapError((error) => inputError(file, error)));
});

export const readText = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(file);
  const label = JSON.stringify(absolute);
  return yield* fs.readFileString(absolute).pipe(
    Effect.mapError((error) => {
      if (error.reason._tag === "PermissionDenied")
        return new PermissionDenied({
          detail: `Cannot read input file ${label}. Grant read access or choose another file.`,
        });
      return new InputError({
        detail:
          error.reason._tag === "NotFound"
            ? `Input file not found: ${label}. Create the file or correct its path.`
            : `Cannot read input file ${label}. Choose a readable file and retry.`,
      });
    }),
  );
});

export interface MessageInput {
  readonly message: string | undefined;
  readonly file: string | undefined;
}

export const messageText = Effect.fnUntraced(function* ({ message, file }: MessageInput) {
  if (message === undefined && file === undefined)
    return yield* new Usage({ detail: "Provide a message argument or --file." });
  if (message !== undefined && file !== undefined)
    return yield* new Usage({ detail: "Provide either a message argument or --file, not both." });
  if (file !== undefined) return yield* readText(file);
  if (message !== undefined) return message;
  return yield* new Usage();
});
