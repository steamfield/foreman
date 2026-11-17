// The daemon fixture runs as a real Bun process, often detached by the daemon client. These tests
// pin that it never outlives the test that started it.
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { takeLock } from "../src/daemon/lock";

const entry = fileURLToPath(new URL("./fixtures/daemon/entry.ts", import.meta.url));
const orphaningParent = fileURLToPath(
  new URL("./fixtures/daemon/orphaning-parent.ts", import.meta.url),
);
const temp = Effect.fnUntraced(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "fm-",
  });
});
const bunPath = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return (yield* spawner.string(ChildProcess.make("which", ["bun"]))).trim();
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};
// Bounded well under the fixture's 30 second idle limit, so only the orphan checks can pass it.
const exitsWithin = Effect.fnUntraced(function* (pid: number) {
  while (alive(pid)) yield* Effect.sleep(20);
}, Effect.timeout("5 seconds"));
const spawnFixture = Effect.fnUntraced(function* (dataDir: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.spawn(
    ChildProcess.make(yield* bunPath(), [entry, dataDir, "test"], {
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: "1 second",
    }),
  );
});

describe("daemon fixture", () => {
  it.live("exits when another process holds the daemon lock", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      assert.isTrue(yield* takeLock(dataDir));
      const child = yield* spawnFixture(dataDir);
      yield* exitsWithin(Number(child.pid));
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(`${dataDir}/ready`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("exits when its data directory is removed", () =>
    Effect.gen(function* () {
      const root = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      const dataDir = `${root}/data`;
      const child = yield* spawnFixture(dataDir);
      while (!(yield* fs.exists(`${dataDir}/ready`))) yield* Effect.sleep(20);
      yield* fs.remove(dataDir, { recursive: true });
      yield* exitsWithin(Number(child.pid));
    }).pipe(Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("exits when the process that started it dies", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const output = yield* spawner.string(
        ChildProcess.make(yield* bunPath(), [orphaningParent, dataDir], { stderr: "inherit" }),
      );
      const pid = Number(output.trim());
      assert.isTrue(Number.isInteger(pid) && pid > 0, `orphaning parent printed ${output}`);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        }),
      );
      yield* exitsWithin(pid);
    }).pipe(Effect.timeout("15 seconds"), Effect.provide(NodeServices.layer)),
  );
});
