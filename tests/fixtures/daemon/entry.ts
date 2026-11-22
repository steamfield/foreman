import { NodeRuntime, NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Fiber, FileSystem, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { daemon } from "../../../src/daemon/server";
import { DaemonSockets } from "../../../src/daemon/sockets";
import { DaemonUnavailable, RunConflict } from "../../../src/errors";
import { openConnection } from "../../../src/providers/codex/client";
import { Host } from "../../../src/services/host";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("data directory required");
const build = process.argv[3] === "daemon" ? "test" : (process.argv[3] ?? "test");
const mode = process.argv[4];
const parent = process.ppid;
if (mode === "legacy") {
  await import("./legacy");
} else {
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (mode === "environment")
        yield* fs.writeFileString(`${dataDir}/log-file`, process.env.FOREMAN_TEST_LOG_FILE ?? "");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const busy = Effect.gen(function* () {
        return (mode === "busy" || mode === "codex-busy") && !(yield* fs.exists(`${dataDir}/idle`));
      }).pipe(Effect.orDie);
      const running = yield* Effect.forkScoped(
        daemon({
          dataDir,
          version: "fixture",
          handler: (body) =>
            Effect.gen(function* () {
              if (body._tag === "Shutdown" && (yield* busy)) return yield* new RunConflict();
              if (body._tag === "Status" && mode === "app-server") {
                const fake = new URL("../fake-app-server/main.mjs", import.meta.url);
                yield* Effect.scoped(
                  openConnection({
                    codexBin: fake.pathname,
                    env: {
                      PATH: process.env.PATH ?? "",
                      FAKE_APP_SERVER_SCENARIO: `${dataDir}/scenario.json`,
                    },
                    version: "fixture",
                    stderr: () => Effect.void,
                  }),
                );
                yield* fs.writeFileString(`${dataDir}/app-server-cwd`, process.cwd());
              }
              return { _tag: "Ok" } as const;
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError((error) =>
                error instanceof RunConflict
                  ? error
                  : new DaemonUnavailable({ detail: `Fixture handler failed: ${error._tag}` }),
              ),
            ),
          busy,
          codexBin: mode === "environment" ? process.env.CODEX_BIN : process.argv[5],
          codexHome: mode === "environment" ? process.env.CODEX_HOME : process.argv[6],
          idleLimitMs: 30_000,
        }),
      );
      // The daemon returns without listening when another process holds its lock, so readiness
      // races the daemon itself rather than waiting for a socket that may never appear.
      const listening = Effect.gen(function* () {
        while (!(yield* fs.exists(`${dataDir}/foreman.sock`))) yield* Effect.sleep(20);
      }).pipe(Effect.timeout("10 seconds"));
      // Clients launch this fixture detached, so nothing stops it when a test run crashes. It
      // exits once the process that started it dies or its test removes the data directory.
      const orphaned = Effect.gen(function* () {
        while (process.ppid === parent && (yield* fs.exists(dataDir))) yield* Effect.sleep(200);
        return yield* Effect.fail(
          new Error(`Fixture daemon for ${dataDir} lost its parent or data directory`),
        );
      });
      yield* Effect.raceFirst(
        Fiber.join(running),
        listening.pipe(
          Effect.andThen(fs.writeFileString(`${dataDir}/ready`, "")),
          Effect.andThen(orphaned),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DaemonSockets.layer({
            connect: (path) => NodeSocket.makeNet({ path }),
            listen: (path) => NodeSocketServer.make({ path }),
          }),
          Host.layer({
            name: "fixture",
            version: "fixture",
            build,
            platform: "node",
            compiled: false,
            executable: [process.execPath, import.meta.filename],
            pid: process.pid,
          }),
        ),
      ),
    ),
  );
}
