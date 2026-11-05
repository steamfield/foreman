import { Effect, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";

/** Consume output while waiting, and release the process on interruption. */
export const commandResult = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, code };
    }),
  );
});
