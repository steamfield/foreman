/**
 * A provider child's stderr log: each line is redacted and appended to a file under the home.
 *
 * Private key blocks span several lines, so the redactor remembers whether it is inside one.
 * When the file can't be written, each child reports that once, as a warning on every run
 * using that child and on runs started while it lives.
 */
import { Effect, type FileSystem, type Path, type PlatformError } from "effect";
import { makeLogAppender, redactDiagnosticText } from "../logging";
import type { Registry } from "./registry";

const PRIVATE_KEY_BEGIN = /-----BEGIN [^-]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [^-]*PRIVATE KEY-----/;
const REDACTED_KEY = "[redacted private key]";

/** One redacted line and whether the next line is still inside a private key block. */
export interface RedactedLine {
  readonly text: string;
  readonly inKeyBlock: boolean;
}

/** Redacts one stderr line, replacing every line of a private key block whole. */
export function redactStderrLine(line: string, inKeyBlock: boolean): RedactedLine {
  const inside = inKeyBlock || PRIVATE_KEY_BEGIN.test(line);
  return {
    text: inside ? REDACTED_KEY : redactDiagnosticText(line),
    inKeyBlock: inside && !PRIVATE_KEY_END.test(line),
  };
}

/**
 * Opens the stderr log for one provider. `sink` makes the stderr callback for one child;
 * `generation` names the child once it is known, so its runs get the unavailable warning.
 * `reset` forgets the warning when a new child starts.
 */
export const makeStderrLog = Effect.fnUntraced(function* (
  logFile: string,
  displayName: string,
  registry: Registry,
) {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const append = yield* makeLogAppender(logFile);
  let warning: string | undefined;

  const warnRuns = Effect.fnUntraced(function* (text: string, generation: symbol | undefined) {
    for (const run of registry.runs.values()) {
      if (run.serverGeneration !== generation) continue;
      yield* registry.enqueue(
        run,
        Effect.gen(function* () {
          if (registry.isCurrent(run) && !run.record.warnings.includes(text))
            yield* registry.save(run, { warnings: [...run.record.warnings, text] });
        }),
      );
    }
  });

  const unavailable = (generation: () => symbol | undefined) =>
    Effect.fnUntraced(function* (error: PlatformError.PlatformError) {
      if (warning !== undefined) return;
      warning = `${displayName} stderr log ${logFile} is unavailable (${error.reason.method}: ${error.reason._tag}). Check the path and directory permissions before relying on this log.`;
      yield* Effect.logWarning("supervisor.appServer.stderr.unavailable").pipe(
        Effect.annotateLogs({
          path: logFile,
          reason: error.reason._tag,
          method: error.reason.method,
        }),
      );
      yield* warnRuns(warning, generation());
    }, Effect.provide(context));

  return {
    sink: (generation: () => symbol | undefined) => {
      const failed = unavailable(generation);
      let inKeyBlock = false;
      return (line: string) => {
        const redacted = redactStderrLine(line, inKeyBlock);
        inKeyBlock = redacted.inKeyBlock;
        return append(`${redacted.text}\n`).pipe(Effect.catch(failed));
      };
    },
    warnings: Effect.sync((): readonly string[] => (warning === undefined ? [] : [warning])),
    reset: Effect.sync(() => {
      warning = undefined;
    }),
  };
});
