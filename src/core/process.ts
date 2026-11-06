import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Drain both pipes while waiting; the scope owns cancellation and process cleanup. */
export const commandResult = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
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
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, code };
    }),
  );
});
