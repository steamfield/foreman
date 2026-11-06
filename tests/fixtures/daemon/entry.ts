import { NodeRuntime, NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Fiber, FileSystem, Layer } from "effect";
import { daemon } from "../../../src/daemon/server";
import { DaemonSockets } from "../../../src/daemon/sockets";
import { Host } from "../../../src/services/host";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("data directory required");
const build = process.argv[3] === "daemon" ? "test" : (process.argv[3] ?? "test");
const mode = process.argv[4];
if (mode === "legacy") {
  await import("./legacy");
} else {
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const busy = Effect.gen(function* () {
        return mode === "busy" && !(yield* fs.exists(`${dataDir}/idle`));
      }).pipe(Effect.orDie);
      const running = yield* Effect.forkScoped(
        daemon({
          dataDir,
          version: "fixture",
          handler: () => Effect.succeed({ _tag: "Ok" }),
          busy,
          idleLimitMs: 30_000,
        }),
      );
      while (!(yield* fs.exists(`${dataDir}/forman.sock`))) yield* Effect.yieldNow;
      yield* fs.writeFileString(`${dataDir}/ready`, "");
      yield* Fiber.join(running);
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
