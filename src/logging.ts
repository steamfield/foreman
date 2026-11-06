import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  PlatformError,
  Predicate,
  References,
  Semaphore,
} from "effect";
import type { LogSettings } from "./config";
import { redactDiagnosticText, secretKey } from "./diagnostic-redaction";
import { Output } from "./services/output";

export { redactDiagnosticText } from "./diagnostic-redaction";

// Shared by the daemon logger and app-server stderr; serialized independently per file.
export const makeLogAppender = Effect.fnUntraced(function* (file: string, formatVersion?: 1) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  return (text: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode(text).length;
        const bounded =
          bytes > 5_000_000
            ? `${JSON.stringify({ msg: "log.record.omitted", bytes, ...(formatVersion === undefined ? {} : { formatVersion }) })}\n`
            : text;
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        const info = yield* fs
          .stat(file)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
        if (
          info !== null &&
          info.size > 0n &&
          info.size + BigInt(new TextEncoder().encode(bounded).length) > 5_000_000n
        )
          yield* fs.rename(file, `${file}.1`);
        yield* fs.writeFileString(file, bounded, { flag: "a", mode: 0o600 });
      }),
    );
});

export type LogEntry = {
  time: string;
  level: string;
  msg: string;
  detail: string[];
  [key: string]: unknown;
};
// Keep the class and frames for diagnosis, excluding messages that may contain input.
export function defectTrace(value: unknown): string {
  if (!(value instanceof Error)) return typeof value;
  const frames = (value.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  return [value.constructor.name, ...frames.map((line) => line.trim())].join("\n");
}

export function causeFields(cause: Cause.Cause<unknown>) {
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  const platform = PlatformError.isPlatformError(error) ? error.reason : undefined;
  let reasonTag = "Unknown";
  if (Cause.hasDies(cause)) reasonTag = "Defect";
  else if (Predicate.hasProperty(error, "_tag") && typeof error._tag === "string")
    reasonTag = error._tag;
  return {
    reasonTag,
    reason: platform?._tag ?? null,
    method: platform?.method ?? null,
    path: platform && "pathOrDescriptor" in platform ? (platform.pathOrDescriptor ?? null) : null,
    ...(Cause.hasDies(cause) ? { trace: defectTrace(Cause.squash(cause)) } : {}),
  };
}

const reserved = new Set([
  "time",
  "level",
  "msg",
  "detail",
  "__proto__",
  "constructor",
  "prototype",
]);
const scalar = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? value
    : "[redacted]";
export function redactDiagnostic(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKey.test(key) ? "[redacted]" : redactDiagnostic(item),
      ]),
    );
  return value;
}
export function entry(input: {
  date: Date;
  level: string;
  message: unknown;
  annotations?: Readonly<Record<string, unknown>>;
}): LogEntry {
  const values: unknown[] = Array.isArray(input.message) ? input.message : [input.message];
  const record: LogEntry = {
    time: input.date.toISOString(),
    level: input.level.toLowerCase(),
    msg: String(scalar(values[0] ?? "")),
    detail: values.slice(1).map((value) => String(scalar(value))),
  };
  for (const [key, value] of Object.entries(input.annotations ?? {}))
    record[reserved.has(key) ? `annotation_${key}` : key] = secretKey.test(key)
      ? "[redacted]"
      : scalar(value);
  return record;
}

export class Logging extends Context.Service<
  Logging,
  {
    logger: Logger.Logger<unknown, void>;
    flush: (settings: LogSettings) => Effect.Effect<void>;
  }
>()("app/Logging") {
  static layer = Layer.effect(
    Logging,
    Effect.gen(function* () {
      const output = yield* Output;
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const appenders = new Map<string, Effect.Success<ReturnType<typeof makeLogAppender>>>();
      const records: LogEntry[] = [];
      let warned = false;
      const logger = Logger.make((input) => {
        records.push(
          entry({
            date: input.date,
            level: input.logLevel,
            message: input.message,
            annotations: input.fiber.getRef(References.CurrentLogAnnotations),
          }),
        );
      });
      return {
        logger,
        flush: (settings) =>
          Effect.gen(function* () {
            for (const record of records.splice(0)) {
              const json = JSON.stringify(record);
              yield* output
                .note(
                  output.json || settings.format === "json"
                    ? json
                    : `${record.time} ${record.level} ${record.msg} ${JSON.stringify(record)}`,
                )
                .pipe(Effect.ignoreCause);
              if (!settings.file) continue;
              let append = appenders.get(settings.file);
              if (!append) {
                append = yield* makeLogAppender(settings.file).pipe(Effect.provide(context));
                appenders.set(settings.file, append);
              }
              yield* append(`${json}\n`).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    if (warned) return;
                    warned = true;
                    const warning = entry({
                      date: new Date(record.time),
                      level: "warn",
                      message: `Log file unavailable: ${settings.file}. Check the path and directory permissions; continuing with stderr.`,
                      annotations: causeFields(cause),
                    });
                    yield* output
                      .note(
                        output.json || settings.format === "json"
                          ? JSON.stringify(warning)
                          : warning.msg,
                      )
                      .pipe(Effect.ignoreCause);
                  }),
                ),
              );
            }
          }),
      };
    }),
  );
}
