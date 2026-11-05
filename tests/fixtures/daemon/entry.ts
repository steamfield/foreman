import { NodeRuntime, NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { daemon } from "../../../src/daemon/server";
import { DaemonSockets } from "../../../src/daemon/sockets";
import { Host } from "../../../src/services/host";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("data directory required");
NodeRuntime.runMain(
  daemon({
    dataDir,
    version: "fixture",
    handler: () => Effect.succeed({ _tag: "Ok" }),
    busy: Effect.succeed(false),
    idleLimitMs: 30_000,
  }).pipe(
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
          platform: "node",
          compiled: false,
          executable: [process.execPath, import.meta.filename],
          pid: process.pid,
        }),
      ),
    ),
  ),
);
