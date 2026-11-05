import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/config";
import { doctor } from "../src/core/doctor";
import { DaemonSockets } from "../src/daemon/sockets";
import { Host } from "../src/services/host";

const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "forman",
    version: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);

const settings = (home: string, codexBin: string) =>
  AppConfig.layer({ HOME: home, FORMAN_DATA_DIR: home, CODEX_BIN: codexBin }).pipe(
    Layer.provideMerge(platform),
  );

const temp = Effect.fnUntraced(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "fm-doc-",
  });
});

const entered = Effect.fnUntraced(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem;
  while (!(yield* fs.exists(marker))) yield* Effect.yieldNow;
});

describe("bounded doctor diagnostics", () => {
  it.effect.each(["version", "protocol", "login"] as const)(
    "reports an unavailable %s check when Codex stalls",
    (stalled) =>
      Effect.gen(function* () {
        const home = yield* temp();
        const fs = yield* FileSystem.FileSystem;
        const bin = `${home}/codex`;
        const marker = `${home}/entered`;
        yield* fs.writeFileString(
          bin,
          `#!${process.execPath}
const fs = require("node:fs");
const probe = { "--version": "version", "app-server": "protocol", "login": "login" }[process.argv[2]];
if (probe === ${JSON.stringify(stalled)}) {
  fs.writeFileSync(${JSON.stringify(marker)}, "entered");
  setInterval(() => {}, 1000);
} else if (probe === "version") {
  console.log("codex-cli 0.166.0");
} else if (probe === "protocol") {
  fs.writeFileSync(process.argv.at(-1) + "/schema.json", "{}");
}
`,
          { mode: 0o755 },
        );
        const pending = yield* Effect.forkScoped(
          doctor().pipe(Effect.provide(settings(home, bin))),
        );
        yield* entered(marker);
        yield* TestClock.adjust("6 seconds");
        const result = yield* TestClock.withLive(
          Fiber.join(pending).pipe(Effect.timeout("2 seconds")),
        );
        expect(result).toMatchObject({
          codexVersion: stalled === "version" ? null : "0.166.0",
          protocolMatches: stalled === "protocol" ? null : false,
          loggedIn: stalled === "login" ? null : true,
          daemon: { state: "not running" },
        });
      }).pipe(Effect.provide(platform)),
  );

  it.effect("reports an unavailable daemon when its socket accepts Ping but never replies", () =>
    Effect.gen(function* () {
      const home = yield* temp();
      const received = yield* Deferred.make<void>();
      const server = yield* NodeSocketServer.make({ path: `${home}/forman.sock` });
      yield* Effect.forkScoped(
        server.run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* socket.reader;
              yield* reader.pull;
              yield* Deferred.succeed(received, undefined);
              yield* Effect.never;
            }),
          ),
        ),
      );
      const pending = yield* Effect.forkScoped(
        doctor().pipe(Effect.provide(settings(home, `${home}/missing-codex`))),
      );
      yield* Deferred.await(received);
      yield* TestClock.adjust("6 seconds");
      const result = yield* TestClock.withLive(
        Fiber.join(pending).pipe(Effect.timeout("2 seconds")),
      );
      expect(result.daemon).toEqual({ state: "not running" });
    }).pipe(Effect.provide(platform)),
  );
});
