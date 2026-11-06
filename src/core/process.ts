import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import { PermissionDenied, WorktreeInvalid } from "../errors";

export const commandOutputLimit = 1_048_576;
export const diagnosticTail = (text: string) =>
  text.trimEnd().split("\n").slice(-20).join("\n").slice(-4096);

interface CaptureOptions {
  readonly output?: "complete" | "tail";
  readonly maxOutputBytes?: number;
}

const captureTail = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number,
) {
  let tail = new Uint8Array(0);
  let truncated = false;
  yield* Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      const length = Math.min(limit, tail.length + chunk.length);
      truncated ||= tail.length + chunk.length > limit;
      const next = new Uint8Array(length);
      const kept = Math.min(chunk.length, length);
      next.set(tail.subarray(tail.length - (length - kept)));
      next.set(chunk.subarray(chunk.length - kept), length - kept);
      tail = next;
    }),
  );
  return { text: new TextDecoder().decode(tail), truncated };
});

/** Drain both pipes while waiting; the scope owns cancellation and process cleanup. */
export const commandResult = Effect.fnUntraced(function* (
  command: ChildProcess.StandardCommand,
  options: CaptureOptions = {},
) {
  const limit = options.maxOutputBytes ?? commandOutputLimit;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    return yield* new WorktreeInvalid({
      detail: "Command output limit must be a positive integer.",
    });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          ...command.options,
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: command.options.forceKillAfter ?? "2 seconds",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [captureTail(handle.stdout, limit), captureTail(handle.stderr, limit), handle.exitCode],
        { concurrency: "unbounded" },
      );
      const overflowNote =
        stdout.truncated || stderr.truncated
          ? `Command output exceeded ${limit} bytes per stream; only the tail was retained.`
          : undefined;
      if (overflowNote && options.output !== "tail")
        return yield* new WorktreeInvalid({
          detail: `${CommandLine.display([command.command, ...command.args])} exited ${code}${command.options.cwd ? ` in ${command.options.cwd}` : ""}: ${overflowNote}\n${diagnosticTail(stdout.text)}\n${diagnosticTail(stderr.text)}\nInspect the command and reduce its output before retrying.`,
        });
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        code,
        ...(overflowNote
          ? {
              truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
              overflowNote,
            }
          : {}),
      };
    }),
  ).pipe(
    Effect.mapError((error) => {
      if (error instanceof WorktreeInvalid) return error;
      const subject = `${CommandLine.display([command.command, ...command.args])}${command.options.cwd ? ` in ${command.options.cwd}` : ""}`;
      const reason = `${error.reason.method} (${error.reason._tag})${"pathOrDescriptor" in error.reason ? `: ${error.reason.pathOrDescriptor}` : ""}`;
      return error.reason._tag === "PermissionDenied"
        ? new PermissionDenied({
            detail: `Cannot run ${subject}: ${reason}. Check the executable and directory permissions, then retry.`,
          })
        : new WorktreeInvalid({
            detail: `Could not run ${subject}: ${reason}. Install ${command.command} or correct the executable and working directory, then retry.`,
          });
    }),
  );
});
