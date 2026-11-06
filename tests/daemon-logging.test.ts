import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { withDaemonLogging } from "../src/commands/daemon";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { DaemonUnavailable } from "../src/errors";
import { main } from "../src/main";
import { AppLayer } from "../src/runtime";
import { RunName, RunRecord } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { makeSupervisor } from "../src/supervisor";
import { ndjson, runCli } from "./helpers/cli";

const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "forman",
    version: "test",
    build: "test",
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
  it.live("keeps failed daemon log sinks actionable and JSON on stderr", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-sink-" });
      const file = `${home}/occupied/log.jsonl`;
      yield* fs.writeFileString(`${home}/occupied`, "file");
      yield* fs.makeDirectory(`${home}/daemon.guard.sqlite`);
      const result = yield* Effect.promise(() =>
        runCli(["daemon", "--json"], {
          env: { FORMAN_HOME: home, TEST_CLI_LOG_FILE: file },
        }),
      );
      expect(result.status).toBe(4);
      expect(result.stdout).toBe("");
      const lines = ndjson(result.stderr);
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: "warn",
          msg: expect.stringContaining(`Daemon log file unavailable: ${file}`),
        }),
      );
      expect(result.stderr).toContain("Check the path and directory permissions");
    }).pipe(Effect.provide(platform)),
  );
  it.live("keeps the safe filesystem operation in a fatal daemon startup record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-fatal-" });
      yield* fs.writeFileString(`${root}/home`, "file");
      const log = `${root}/fatal.jsonl`;
      const status = yield* main(["daemon"]).pipe(
        Effect.provide(
          AppLayer(
            {
              HOME: root,
              FORMAN_HOME: `${root}/home`,
              FORMAN_LOG_FILE: log,
            },
            false,
            async () => {},
            async () => {},
          ),
        ),
      );
      expect(status).toBe(4);
      const records = (yield* fs.readFileString(log))
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(line),
        );
      const fatal = records.find((record) => record.msg === "daemon.failed");
      expect(fatal).toMatchObject({ operationDetail: expect.stringContaining("makeDirectory") });
      expect(fatal).toMatchObject({ operationDetail: expect.stringContaining(`${root}/home`) });
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["platform", "defect", "socket"] as const)(
    "drains a fatal %s cause safely before returning",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-fatal-" });
        const app = AppLayer(
          { HOME: root, FORMAN_HOME: root },
          false,
          async () => {},
          async () => {},
        );
        let work: Effect.Effect<void, unknown> = Effect.fail(
          new DaemonUnavailable({ detail: `Socket path exceeds 104 bytes: ${root}` }),
        );
        if (kind === "platform") work = fs.readFileString(`${root}/missing`).pipe(Effect.asVoid);
        if (kind === "defect") work = Effect.die(new TypeError("PRIVATE_SECRET=do-not-record"));
        yield* withDaemonLogging(work).pipe(Effect.exit, Effect.provide(app));
        const text = yield* fs.readFileString(`${root}/logs/daemon.jsonl`);
        const records = text
          .trim()
          .split("\n")
          .map((line) =>
            Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
            )(line),
          );
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          msg: "daemon.failed",
          level: "error",
          ...(kind === "platform"
            ? { method: "readFile", path: `${root}/missing`, reason: "NotFound" }
            : {}),
          ...(kind === "defect" ? { trace: expect.stringContaining("TypeError\nat ") } : {}),
          ...(kind === "socket" ? { operationDetail: expect.stringContaining("104 bytes") } : {}),
        });
        expect(text).not.toContain("PRIVATE_SECRET");
        expect(text).not.toContain("do-not-record");
      }).pipe(Effect.provide(platform)),
  );
  it.live.each(["platform", "schema"])(
    "logs one %s request failure with request and run annotations",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-log-" });
        const runDir = `${root}/runs/unit-a`;
        yield* fs.makeDirectory(runDir, { recursive: true });
        const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunRecord))(
          yield* fs.readFileString(
            fileURLToPath(new URL("./fixtures/runs/run.json", import.meta.url)),
          ),
        );
        yield* fs.writeFileString(
          `${runDir}/run.json`,
          Schema.encodeSync(Schema.fromJsonString(RunRecord))({
            ...record,
            state: "idle",
            worktree: `${root}/removed`,
          }),
        );
        const questions = `${runDir}/questions.jsonl`;
        if (kind === "platform") yield* fs.makeDirectory(questions);
        else yield* fs.writeFileString(questions, "PRIVATE_SECRET=do-not-record\n");
        const app = AppLayer(
          { HOME: root, FORMAN_HOME: root },
          false,
          async () => {},
          async () => {},
        );
        const status = yield* main(
          ["status"],
          withDaemonLogging(
            Effect.scoped(
              Effect.gen(function* () {
                const supervisor = yield* makeSupervisor();
                yield* supervisor.handler({ _tag: "Status", name: record.name, cwd: root });
              }),
            ),
          ),
        ).pipe(Effect.provide(app));
        expect(status).toBe(8);
        const text = yield* fs.readFileString(`${root}/logs/daemon.jsonl`);
        const records = text
          .trim()
          .split("\n")
          .map((line) =>
            Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
            )(line),
          );
        const failures = records.filter((record) => record.msg === "supervisor.request.failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          request: "Status",
          name: "unit-a",
          reasonTag: kind === "platform" ? "PlatformError" : "SchemaError",
          ...(kind === "platform" ? { method: "readFile", path: questions } : {}),
        });
        expect(text).not.toContain("PRIVATE_SECRET");
        expect(text).not.toContain("do-not-record");
      }).pipe(Effect.provide(platform)),
  );
  it.live("keeps a skipped run's name as a scalar annotation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-log-" });
      yield* fs.makeDirectory(`${root}/runs/broken`, { recursive: true });
      yield* fs.writeFileString(`${root}/runs/broken/run.json`, "corrupt\n");
      const app = AppLayer(
        { HOME: root, FORMAN_HOME: root },
        false,
        async () => {},
        async () => {},
      );
      const status = yield* main(
        ["status"],
        withDaemonLogging(
          Effect.scoped(
            Effect.gen(function* () {
              const supervisor = yield* makeSupervisor();
              yield* supervisor.handler({
                _tag: "Status",
                name: Schema.decodeUnknownSync(RunName)("missing"),
                cwd: root,
              });
            }),
          ),
        ),
      ).pipe(Effect.provide(app));
      expect(status).toBe(7);
      const records = (yield* fs.readFileString(`${root}/logs/daemon.jsonl`))
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(line),
        );
      expect(records.find((record) => record.msg === "supervisor.run.skipped")).toMatchObject({
        name: "broken",
        detail: [],
      });
      expect(records.filter((record) => record.msg === "supervisor.request.failed")).toMatchObject([
        { request: "Status", name: "missing", reasonTag: "RunNotFound" },
      ]);
    }).pipe(Effect.provide(platform)),
  );
  it.live(
    "flushes one handler defect with frames but no private message through a real socket",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-log-" });
        const app = AppLayer(
          { HOME: root, FORMAN_HOME: root },
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
        { HOME: root, FORMAN_HOME: root },
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
