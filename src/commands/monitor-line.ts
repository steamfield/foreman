import cliTruncate from "cli-truncate";
import { Clock, Effect, Predicate, Stream } from "effect";
import { AppConfig } from "../config";
import type { MonitorFeed } from "../core/monitor/feed";
import { lineSegments } from "../core/monitor/line";
import { BrokenPipe, PermissionDenied } from "../errors";
import { Output } from "../services/output";
import { Terminal } from "../services/terminal";
import { theme } from "../tui/theme";

/**
 * Prints the passive monitor feed once or streams compact updates until interrupted.
 * @throws {BrokenPipe} When the output destination closes.
 * @throws {PermissionDenied} When the output destination denies writes.
 */
export const runMonitorLine = Effect.fn("monitor.line")(function* <R>(
  feed: Stream.Stream<MonitorFeed, never, R>,
  once: boolean,
) {
  const output = yield* Output;
  const terminal = yield* Terminal;
  const config = yield* AppConfig;
  const colors = theme(
    terminal.stdoutIsTTY ? 3 : 0,
    config.inheritedEnvironment.NO_COLOR !== undefined,
  );
  const lines = feed.pipe(
    Stream.mapEffect((value) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const line = lineSegments(value, now)
            .map(({ text, tone }) => colors.paint(text, tone))
            .join("");
          return terminal.stdoutIsTTY ? cliTruncate(line, Math.max(0, terminal.columns - 1)) : line;
        }),
      ),
    ),
  );
  if (once) return yield* lines.pipe(Stream.take(1), Stream.runForEach(output.line));
  const stdout = terminal.stdout;
  if (!terminal.stdoutIsTTY || stdout === null)
    return yield* lines.pipe(Stream.changes, Stream.runForEach(output.line));
  yield* Effect.acquireUseRelease(
    Effect.void,
    () => lines.pipe(Stream.runForEach((line) => write(stdout, `\r${line}\u001b[K`))),
    () => write(stdout, "\n"),
  );
});

const write = (stdout: NodeJS.WritableStream, text: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        stdout.write(text, (error) => (error ? reject(error) : resolve()));
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error): Effect.Effect<never, BrokenPipe | PermissionDenied> => {
      if (Predicate.hasProperty(error, "code")) {
        if (error.code === "EPIPE") return Effect.fail(new BrokenPipe());
        if (error.code === "EACCES" || error.code === "EPERM")
          return Effect.fail(
            new PermissionDenied({
              detail:
                "Cannot write to stdout. Check the output destination and its permissions, then retry.",
            }),
          );
      }
      return Effect.die(error);
    }),
  );
