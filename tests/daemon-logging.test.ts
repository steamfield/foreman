import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { withDaemonLogging } from "../src/commands/daemon";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { main } from "../src/main";
import { AppLayer } from "../src/runtime";
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
const Record = Schema.Struct({
  level: Schema.String,
  msg: Schema.String,
  trace: Schema.optionalKey(Schema.String),
});

describe("daemon file logging", () => {
  it.live(
    "flushes one handler defect with frames but no private message through a real socket",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-log-" });
        const app = AppLayer(
          { HOME: root, FORMAN_DATA_DIR: root },
          false,
          async () => {},
          async () => {},
        );
        const request = (body: Parameters<typeof call>[0]) =>
          call(body, { dataDir: root, connectOnly: true });
        const running = yield* main(
          ["daemon"],
          withDaemonLogging(
            daemon({
              dataDir: root,
              version: "test",
              busy: Effect.succeed(false),
              handler: (body) =>
                body._tag === "Shutdown"
                  ? Effect.succeed({ _tag: "Ok" })
                  : Effect.die(new TypeError("PRIVATE_SECRET=do-not-record")),
            }),
          ),
        ).pipe(Effect.provide(app), Effect.forkScoped);
        yield* Effect.raceFirst(
          Fiber.join(running),
          Effect.gen(function* () {
            while ((yield* request({ _tag: "Ping" }).pipe(Effect.result))._tag === "Failure")
              yield* Effect.yieldNow;
          }),
        );
        expect(yield* request({ _tag: "Status", cwd: root }).pipe(Effect.flip)).toMatchObject({
          _tag: "Defect",
        });
        yield* request({ _tag: "Shutdown" });
        expect(yield* Fiber.join(running)).toBe(0);
        const text = yield* fs.readFileString(`${root}/logs/daemon.jsonl`);
        const records = text
          .trim()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Record))(line));
        expect(records.filter(({ level }) => level === "error")).toEqual([
          {
            level: "error",
            msg: "daemon.handler.defect",
            trace: expect.stringContaining("TypeError\nat "),
          },
        ]);
        expect(text).not.toContain("PRIVATE_SECRET");
        expect(text).not.toContain("do-not-record");
      }).pipe(Effect.provide(platform)),
  );

  it.live("the daemon command flushes one start and stop record at the default log level", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-log-" });
      const app = AppLayer(
        { HOME: root, FORMAN_DATA_DIR: root },
        false,
        async () => {},
        async () => {},
      );
      const running = yield* main(["daemon"]).pipe(Effect.provide(app), Effect.forkScoped);
      yield* Effect.raceFirst(
        Fiber.join(running),
        Effect.gen(function* () {
          while (
            (yield* call({ _tag: "Ping" }, { dataDir: root, connectOnly: true }).pipe(
              Effect.result,
            ))._tag === "Failure"
          )
            yield* Effect.yieldNow;
        }),
      );
      yield* call({ _tag: "Shutdown" }, { dataDir: root, connectOnly: true });
      expect(yield* Fiber.join(running)).toBe(0);
      const text = yield* fs.readFileString(`${root}/logs/daemon.jsonl`);
      const records = text
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Record))(line));
      expect(records.filter(({ msg }) => msg === "daemon.started")).toEqual([
        { level: "info", msg: "daemon.started" },
      ]);
      expect(records.filter(({ msg }) => msg === "daemon.stopped")).toEqual([
        { level: "info", msg: "daemon.stopped" },
      ]);
    }).pipe(Effect.provide(platform)),
  );
});
