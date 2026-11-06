import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Queue,
  Ref,
  References,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { call, shutdown } from "../src/daemon/client";
import { releaseLock } from "../src/daemon/lock";
import { lines, requestJson, responseJson } from "../src/daemon/protocol";
import { type DaemonOptions, daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { DaemonUnavailable, Defect, detailFor, errorClasses } from "../src/errors";
import type { DaemonResult } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { runCli } from "./helpers/cli";

const sockets = DaemonSockets.layer({
  connect: (path) => NodeSocket.makeNet({ path }),
  listen: (path) => NodeSocketServer.make({ path }),
});
const host = (executable: ReadonlyArray<string> = [process.execPath]) =>
  Host.layer({
    name: "forman-test",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    pid: process.pid,
    executable,
  });
const platform = Layer.mergeAll(NodeServices.layer, sockets, host());
const temp = Effect.fnUntraced(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "fm-",
  });
});
const options = (dataDir: string, extra: Partial<DaemonOptions> = {}): DaemonOptions => ({
  dataDir,
  version: "test",
  handler: () => Effect.succeed({ _tag: "Ok" }),
  busy: Effect.succeed(false),
  ...extra,
});
const ping = (dataDir: string) => call({ _tag: "Ping" }, { dataDir, connectOnly: true });
const waitForExit = Effect.fnUntraced(function* (pid: number) {
  const gone = Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      throw error;
    }
  });
  while (!(yield* gone)) yield* Effect.sleep(20);
}, Effect.timeout("5 seconds"));
const ready = Effect.fnUntraced(function* (dataDir: string) {
  while (true) {
    const result = yield* Effect.result(ping(dataDir));
    if (result._tag === "Success") return result.success;
    yield* Effect.yieldNow;
  }
});
const start = Effect.fnUntraced(function* (config: DaemonOptions) {
  const fiber = yield* Effect.forkScoped(daemon(config));
  yield* ready(config.dataDir);
  return fiber;
});
const peer = Effect.fnUntraced(function* (dataDir: string) {
  const socket = yield* NodeSocket.makeNet({ path: `${dataDir}/forman.sock` });
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const responses =
    yield* Queue.unbounded<typeof import("../src/schemas/daemon").DaemonResponse.Type>();
  const reading = yield* Effect.forkScoped(
    lines(reader).pipe(
      Stream.mapEffect((line) => Schema.decodeUnknownEffect(responseJson)(line)),
      Stream.runForEach((response) => Queue.offer(responses, response)),
    ),
  );
  return { writer, responses, reading };
});

const observeClosures = Effect.fnUntraced(function* () {
  const closed = yield* Queue.unbounded<void>();
  const logger = Logger.make((input) => {
    const messages: ReadonlyArray<unknown> = Array.isArray(input.message)
      ? input.message
      : [input.message];
    if (messages.includes("daemon.connection.closed")) Queue.offerUnsafe(closed, undefined);
  });
  return { closed: Queue.take(closed), layer: Logger.layer([logger]) };
});

describe("daemon lifecycle and protocol", () => {
  for (const mode of ["same", "outdated", "legacy", "busy", "racing"] as const) {
    it.live(`handles a ${mode} daemon build before executing the call`, () =>
      Effect.gen(function* () {
        const dataDir = yield* temp();
        const fs = yield* FileSystem.FileSystem;
        const bun = (yield* (yield* ChildProcessSpawner.ChildProcessSpawner).string(
          ChildProcess.make("which", ["bun"]),
        )).trim();
        const fixture = fileURLToPath(new URL("./fixtures/daemon/entry.ts", import.meta.url));
        const executable = [bun, fixture, dataDir, "test"];
        const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          ChildProcess.make(bun, [fixture, dataDir, mode === "same" ? "test" : "old", mode], {
            stdout: "ignore",
            stderr: "inherit",
          }),
        );
        // Observe readiness without the upgrading client, including the legacy wire format.
        while (!(yield* fs.exists(`${dataDir}/ready`))) yield* Effect.yieldNow;
        let notices = 0;
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let holdShutdown = mode === "racing";
        const requests: string[] = [];
        let connections = 0;
        const client = Layer.mergeAll(
          host(executable),
          DaemonSockets.layer({
            connect: (path) =>
              NodeSocket.makeNet({ path }).pipe(
                Effect.map((socket) => {
                  return Socket.make({
                    reader: socket.reader.pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          connections += 1;
                        }),
                      ),
                    ),
                    writer: socket.writer.pipe(
                      Effect.map((writer) => ({
                        ...writer,
                        write: (chunk) =>
                          Effect.gen(function* () {
                            if (typeof chunk === "string") {
                              const tag = Schema.decodeUnknownSync(requestJson)(chunk.trimEnd())
                                .body._tag;
                              requests.push(tag);
                              if (tag === "Shutdown" && holdShutdown) {
                                holdShutdown = false;
                                yield* Deferred.succeed(paused, undefined);
                                yield* Deferred.await(release);
                              }
                            }
                          }).pipe(Effect.andThen(writer.write(chunk))),
                      })),
                    ),
                  });
                }),
              ),
            listen: (path) => NodeSocketServer.make({ path }),
          }),
        );
        const callOptions = {
          dataDir,
          onOutdated: Effect.sync(() => {
            notices += 1;
          }),
        };
        yield* Effect.addFinalizer(() =>
          fs
            .writeFileString(`${dataDir}/idle`, "")
            .pipe(
              Effect.andThen(shutdown(dataDir)),
              Effect.asVoid,
              Effect.orDie,
              Effect.provide(client),
            ),
        );
        const first = yield* Effect.forkChild(
          call({ _tag: "Status", cwd: "/tmp" }, callOptions).pipe(Effect.provide(client)),
        );
        if (mode === "racing") {
          yield* Deferred.await(paused);
          assert.deepStrictEqual(
            yield* call({ _tag: "Status", cwd: "/tmp" }, callOptions).pipe(
              Effect.provide(host(executable)),
            ),
            { _tag: "Ok" },
          );
          yield* Deferred.succeed(release, undefined);
        }
        assert.deepStrictEqual(yield* Fiber.join(first), { _tag: "Ok" });
        let expectedRequests = ["Ping", "Shutdown", "Status"];
        if (mode === "same") expectedRequests = ["Ping", "Status"];
        if (mode === "racing") expectedRequests = ["Ping", "Shutdown", "Ping", "Status"];
        assert.deepStrictEqual(requests, expectedRequests);
        assert.strictEqual(
          connections,
          mode === "outdated" || mode === "legacy" || mode === "racing" ? 2 : 1,
        );
        assert.strictEqual(notices, mode === "busy" ? 1 : 0);
        const result = yield* call({ _tag: "Ping" }, callOptions).pipe(Effect.provide(client));
        assert.deepStrictEqual(
          requests.slice(expectedRequests.length),
          mode === "busy" ? ["Ping", "Shutdown"] : ["Ping"],
        );
        assert.strictEqual(result._tag, "Pong");
        if (result._tag !== "Pong") return;
        if (mode === "same" || mode === "busy") {
          assert.strictEqual(result.pid, Number(child.pid));
        } else {
          assert.notStrictEqual(result.pid, Number(child.pid));
          assert.strictEqual(result.build, "test");
          yield* waitForExit(Number(child.pid));
          assert.strictEqual(yield* child.exitCode, 0);
        }
        if (mode === "busy") {
          // One warning per invocation. Ping above is a second invocation.
          assert.strictEqual(notices, 2);
          yield* fs.writeFileString(`${dataDir}/idle`, "");
          const replaced = yield* call({ _tag: "Ping" }, { dataDir }).pipe(Effect.provide(client));
          assert.strictEqual(replaced._tag, "Pong");
          if (replaced._tag === "Pong") assert.notStrictEqual(replaced.pid, result.pid);
          yield* waitForExit(result.pid);
        } else assert.strictEqual(notices, 0);
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    );
  }

  it.live("daemon stop through the CLI makes the daemon pid disappear within five seconds", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bun = (yield* spawner.string(ChildProcess.make("which", ["bun"]))).trim();
      const child = yield* spawner.spawn(
        ChildProcess.make(
          bun,
          [fileURLToPath(new URL("./fixtures/daemon/entry.ts", import.meta.url)), dataDir],
          { stdout: "ignore", stderr: "inherit", forceKillAfter: "2 seconds" },
        ),
      );
      yield* ready(dataDir).pipe(Effect.timeout("3 seconds"));
      const result = yield* Effect.promise(() =>
        runCli(["daemon", "stop"], {
          home: dataDir,
          env: { TEST_CLI_DATA_DIR: dataDir },
        }),
      );
      assert.deepStrictEqual(result, { status: 0, stdout: "Daemon stopped.\n", stderr: "" });
      yield* waitForExit(Number(child.pid));
    }).pipe(Effect.provide(platform)),
  );

  it.live("serves Ping itself and decodes a handler result", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      yield* start(
        options(dataDir, { handler: () => Effect.succeed({ _tag: "Digests", digests: [] }) }),
      );
      assert.deepStrictEqual(yield* ping(dataDir), {
        _tag: "Pong",
        version: "test",
        pid: process.pid,
        build: "test",
      });
      assert.deepStrictEqual(yield* call({ _tag: "Status", cwd: "/tmp" }, { dataDir }), {
        _tag: "Digests",
        digests: [],
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live("acknowledges Shutdown before closing and removes its socket and lock", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const running = yield* start(options(dataDir));
      assert.deepStrictEqual(yield* call({ _tag: "Shutdown" }, { dataDir, connectOnly: true }), {
        _tag: "Ok",
      });
      yield* Fiber.join(running).pipe(Effect.timeout("2 seconds"));
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );

  it.live("shutdown exits even with another client connection still open", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const running = yield* start(options(dataDir));
      const connection = yield* peer(dataDir);
      yield* connection.writer.write('{"id":2,"body":{"_tag":"Ping"}}\n');
      yield* Queue.take(connection.responses);
      assert.isTrue(yield* shutdown(dataDir));
      yield* Fiber.join(running).pipe(Effect.timeout("1 second"));
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: shutdown waits for old ownership cleanup before a replacement starts", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      const running = yield* start(options(dataDir));
      const guard = `${dataDir}/daemon.reclaim`;
      yield* fs.makeDirectory(guard);
      yield* fs.writeFileString(`${guard}/held`, "");
      yield* Effect.addFinalizer(() =>
        fs.remove(guard, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const returned = yield* Deferred.make<void>();
      const stopping = yield* Effect.forkScoped(
        shutdown(dataDir).pipe(Effect.tap(() => Deferred.succeed(returned, undefined))),
      );
      while ((yield* ping(dataDir).pipe(Effect.result))._tag === "Success") yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.await(returned).pipe(Effect.timeoutOption(250))));
      yield* fs.remove(guard, { recursive: true });
      assert.isTrue(yield* Fiber.join(stopping).pipe(Effect.timeout("2 seconds")));
      yield* Fiber.join(running);
      const replacement = yield* start(options(dataDir, { version: "replacement" }));
      assert.deepStrictEqual(yield* ping(dataDir), {
        _tag: "Pong",
        version: "replacement",
        pid: process.pid,
        build: "test",
      });
      yield* call({ _tag: "Shutdown" }, { dataDir, connectOnly: true });
      yield* Fiber.join(replacement);
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: accepted shutdown survives the requesting client disconnecting", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const writing = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const observed = DaemonSockets.layer({
        connect: (path) => NodeSocket.makeNet({ path }),
        listen: (path) =>
          NodeSocketServer.make({ path }).pipe(
            Effect.map((server) => ({
              ...server,
              run: (handler) =>
                server.run((socket) =>
                  handler(
                    Socket.make({
                      reader: socket.reader,
                      writer: socket.writer.pipe(
                        Effect.map((writer) => ({
                          ...writer,
                          write: (chunk) =>
                            typeof chunk === "string" && chunk.includes('"id":2')
                              ? Deferred.succeed(writing, undefined).pipe(
                                  Effect.andThen(Deferred.await(held)),
                                  Effect.andThen(writer.write(chunk)),
                                )
                              : writer.write(chunk),
                        })),
                      ),
                    }),
                  ),
                ),
            })),
          ),
      });
      const running = yield* Effect.forkScoped(
        daemon(options(dataDir)).pipe(Effect.provide(observed)),
      );
      yield* ready(dataDir);
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const connection = yield* peer(dataDir).pipe(Scope.provide(scope));
      yield* connection.writer.write('{"id":2,"body":{"_tag":"Shutdown"}}\n');
      yield* Deferred.await(writing);
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(running).pipe(Effect.timeout("1 second"));
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: shutdown cleans up a backpressured non-reading client", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const responding = yield* Deferred.make<void>();
      const running = yield* start(
        options(dataDir, {
          handler: (body) =>
            body._tag === "Status"
              ? Deferred.succeed(responding, undefined).pipe(
                  Effect.as<DaemonResult>({
                    _tag: "Events",
                    gap: false,
                    next: 1,
                    events: [
                      {
                        seq: 1,
                        at: DateTime.makeUnsafe(0),
                        event: {
                          _tag: "AgentMessage",
                          phase: null,
                          text: "x".repeat(16 * 1024 * 1024),
                        },
                      },
                    ],
                  }),
                )
              : Effect.succeed({ _tag: "Ok" }),
        }),
      );
      const socket = yield* NodeSocket.makeNet({ path: `${dataDir}/forman.sock` });
      yield* socket.reader;
      const writer = yield* socket.writer;
      yield* writer.write('{"id":2,"body":{"_tag":"Status","cwd":"/tmp"}}\n');
      yield* Deferred.await(responding);
      yield* call({ _tag: "Shutdown" }, { dataDir, connectOnly: true });
      yield* Fiber.join(running).pipe(Effect.timeout("1 second"));
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );

  it.live("shutdown with no daemon succeeds without spawning a launcher", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      const launcher = `${dataDir}/launcher.mjs`;
      const marker = `${dataDir}/spawned`;
      yield* fs.writeFileString(
        launcher,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");`,
      );
      assert.isFalse(
        yield* shutdown(dataDir).pipe(Effect.provide(host([process.execPath, launcher]))),
      );
      assert.isFalse(yield* fs.exists(marker));
      assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );

  it.live("simultaneous starts leave one server and a successful losing daemon", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const first = yield* Effect.forkScoped(daemon(options(dataDir, { version: "first" })));
      const second = yield* Effect.forkScoped(daemon(options(dataDir, { version: "second" })));
      const result = yield* ready(dataDir);
      assert.strictEqual(result._tag, "Pong");
      if (result._tag !== "Pong") return;
      const loser = result.version === "first" ? second : first;
      yield* Fiber.join(loser);
      assert.deepStrictEqual(yield* ping(dataDir), result);
    }).pipe(Effect.provide(platform)),
  );

  it.live("simultaneous stale-lock takeovers leave exactly one serving daemon", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* temp();
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "");
      yield* fs.utimes(`${dataDir}/daemon.lock`, 0, 0);
      const observed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let held = false;
      // Keep real filesystem operations, but force the stale-stat/unlink interleaving.
      const filesystem: FileSystem.FileSystem = {
        ...fs,
        stat: (path) =>
          fs.stat(path).pipe(
            Effect.tap(() => {
              if (path !== `${dataDir}/daemon.lock` || held) return Effect.void;
              held = true;
              return Deferred.succeed(observed, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
            }),
          ),
        writeFileString: (path, value, config) =>
          fs
            .writeFileString(path, value, config)
            .pipe(
              Effect.tap(() =>
                path === `${dataDir}/daemon.lock` && config?.flag === "wx"
                  ? Deferred.succeed(release, undefined)
                  : Effect.void,
              ),
            ),
      };
      const first = yield* Effect.forkScoped(
        daemon(options(dataDir, { version: "first" })).pipe(
          Effect.provideService(FileSystem.FileSystem, filesystem),
        ),
      );
      yield* Deferred.await(observed);
      const second = yield* Effect.forkScoped(
        daemon(options(dataDir, { version: "second" })).pipe(
          Effect.provideService(FileSystem.FileSystem, filesystem),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        ),
      );
      const result = yield* ready(dataDir);
      assert.strictEqual(result._tag, "Pong");
      if (result._tag !== "Pong") return;
      yield* Fiber.join(result.version === "first" ? second : first).pipe(Effect.timeout(500));
      assert.deepStrictEqual(yield* ping(dataDir), result);
    }).pipe(Effect.provide(platform)),
  );

  it.live("cancels blocked handlers as soon as their connection closes", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* start(
        options(dataDir, {
          handler: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as<DaemonResult>({ _tag: "Ok" }),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* peer(dataDir);
          yield* connection.writer.write('{"id":1,"body":{"_tag":"Status","cwd":"/tmp"}}\n');
          yield* Deferred.await(entered);
        }),
      );
      yield* Deferred.await(cancelled).pipe(Effect.timeout(500));
    }).pipe(Effect.provide(platform)),
  );

  it.live("logs a handler defect once without private handler content", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const records: string[] = [];
      const logger = Logger.make((input) =>
        records.push(
          JSON.stringify({
            message: input.message,
            annotations: input.fiber.getRef(References.CurrentLogAnnotations),
            cause: input.cause,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        yield* start(
          options(dataDir, { handler: () => Effect.die(new Error("private handler text")) }),
        );
        assert.instanceOf(
          yield* Effect.flip(call({ _tag: "Status", cwd: "/tmp" }, { dataDir })),
          Defect,
        );
      }).pipe(Effect.provide(Logger.layer([logger])));
      assert.strictEqual(
        records.filter((record) => record.includes("daemon.handler.defect")).length,
        1,
      );
      assert.notInclude(records.join("\n"), "private handler text");
      assert.include(records.join("\n"), "defect");
    }).pipe(Effect.provide(platform)),
  );

  it.effect.each(["idle", "requested"] as const)(
    "closes the listener before interrupting dispatch during %s shutdown",
    (kind) =>
      Effect.gen(function* () {
        const observation = yield* observeClosures();
        yield* Effect.gen(function* () {
          const dataDir = yield* temp();
          const stopping = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const observedSockets = DaemonSockets.layer({
            connect: (path) => NodeSocket.makeNet({ path }),
            listen: (path) =>
              NodeSocketServer.make({ path }).pipe(
                Effect.map((server) => ({
                  ...server,
                  run: (handler) =>
                    server
                      .run(handler)
                      .pipe(
                        Effect.onInterrupt(() =>
                          Deferred.succeed(stopping, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                          ),
                        ),
                      ),
                })),
              ),
          });
          const running = yield* Effect.forkScoped(
            daemon(options(dataDir, { idleLimitMs: 1000 })).pipe(Effect.provide(observedSockets)),
          );
          yield* ready(dataDir);
          yield* observation.closed;
          if (kind === "idle") yield* TestClock.adjust(2000);
          else
            assert.deepStrictEqual(
              yield* call({ _tag: "Shutdown" }, { dataDir, connectOnly: true }),
              { _tag: "Ok" },
            );
          yield* TestClock.adjust(100);
          yield* Deferred.await(stopping);
          const connection = yield* Effect.scoped(
            Effect.gen(function* () {
              return yield* (yield* NodeSocket.makeNet({ path: `${dataDir}/forman.sock` })).reader;
            }),
          ).pipe(Effect.result);
          yield* Deferred.succeed(release, undefined);
          yield* TestClock.adjust(100);
          yield* Fiber.join(running);
          assert.strictEqual(connection._tag, "Failure");
        }).pipe(
          Effect.provide(observation.layer),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        );
      }).pipe(Effect.provide(platform)),
  );

  it.live("takes over an old lock and removes a leftover socket file", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "");
      yield* fs.utimes(`${dataDir}/daemon.lock`, 0, 0);
      yield* fs.writeFileString(`${dataDir}/forman.sock`, "leftover");
      yield* start(options(dataDir));
      assert.strictEqual((yield* ping(dataDir))._tag, "Pong");
    }).pipe(Effect.provide(platform)),
  );

  it.live("recovers a stale reclaim guard left by a killed reclaimer", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "");
      yield* fs.utimes(`${dataDir}/daemon.lock`, 0, 0);
      yield* fs.makeDirectory(`${dataDir}/daemon.reclaim`);
      yield* fs.writeFileString(`${dataDir}/daemon.reclaim/old-owner`, "");
      yield* fs.utimes(`${dataDir}/daemon.reclaim/old-owner`, 0, 0);
      yield* start(options(dataDir));
      assert.strictEqual((yield* ping(dataDir))._tag, "Pong");
      assert.deepStrictEqual(yield* fs.readDirectory(`${dataDir}/daemon.reclaim`), []);
    }).pipe(Effect.provide(platform)),
  );

  it.live("leaves a fresh reclaimer alone while it owns a stale lock", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "");
      yield* fs.utimes(`${dataDir}/daemon.lock`, 0, 0);
      yield* fs.makeDirectory(`${dataDir}/daemon.reclaim`);
      yield* fs.writeFileString(`${dataDir}/daemon.reclaim/current-owner`, "");
      yield* daemon(options(dataDir));
      assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
      assert.deepStrictEqual(yield* fs.readDirectory(`${dataDir}/daemon.reclaim`), [
        "current-owner",
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("shutdown cleanup preserves files belonging to a replacement lock", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "original");
      const original = yield* fs.stat(`${dataDir}/daemon.lock`);
      yield* fs.rename(`${dataDir}/daemon.lock`, `${dataDir}/original.lock`);
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "replacement");
      yield* fs.writeFileString(`${dataDir}/forman.sock`, "replacement socket");
      yield* Effect.scoped(releaseLock(dataDir, `${dataDir}/forman.sock`, original));
      assert.strictEqual(yield* fs.readFileString(`${dataDir}/daemon.lock`), "replacement");
      assert.strictEqual(yield* fs.readFileString(`${dataDir}/forman.sock`), "replacement socket");
    }).pipe(Effect.provide(platform)),
  );

  it.live("leaves a fresh lock alone when its owner is still starting", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "");
      yield* daemon(options(dataDir));
      assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
      assert.isTrue(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );

  it.live("refuses socket paths longer than 104 bytes including multibyte characters", () =>
    Effect.gen(function* () {
      const dataDir = `/tmp/${"é".repeat(48)}`;
      const error = yield* Effect.flip(daemon(options(dataDir)));
      assert.instanceOf(error, DaemonUnavailable);
      assert.include(error.detail, "104 bytes");
    }).pipe(Effect.provide(platform)),
  );

  it.live("dispatches requests concurrently on one connection and preserves ids", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* start(
        options(dataDir, {
          handler: (body) =>
            body._tag === "Wait"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ _tag: "Ok" }),
                )
              : Effect.succeed({ _tag: "Digests", digests: [] }),
        }),
      );
      const { writer, responses } = yield* peer(dataDir);
      yield* writer.write(
        `${JSON.stringify({ id: 41, body: { _tag: "Wait", names: [], all: true, cwd: "/tmp", timeoutMs: 1000 } })}\n`,
      );
      yield* Deferred.await(entered);
      yield* writer.write(`${JSON.stringify({ id: 42, body: { _tag: "Status", cwd: "/tmp" } })}\n`);
      assert.deepStrictEqual(yield* Queue.take(responses), {
        id: 42,
        result: { _tag: "Digests", digests: [] },
      });
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Queue.take(responses), { id: 41, result: { _tag: "Ok" } });
    }).pipe(Effect.provide(platform)),
  );

  for (const Class of errorClasses) {
    it.live(`round trips ${new Class()._tag} with its detail`, () =>
      Effect.gen(function* () {
        const dataDir = yield* temp();
        const original = new Class({ detail: "run example" });
        yield* start(options(dataDir, { handler: () => Effect.fail(original) }));
        const error = yield* Effect.flip(call({ _tag: "Status", cwd: "/tmp" }, { dataDir }));
        assert.isTrue(error instanceof Class);
        assert.strictEqual(detailFor(error), detailFor(original));
      }).pipe(Effect.provide(platform)),
    );
  }

  it.live("sends defects without their detail and keeps serving requests", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      yield* start(options(dataDir, { handler: () => Effect.die("private defect text") }));
      const error = yield* Effect.flip(call({ _tag: "Status", cwd: "/tmp" }, { dataDir }));
      assert.instanceOf(error, Defect);
      assert.isUndefined(detailFor(error));
      assert.strictEqual((yield* ping(dataDir))._tag, "Pong");
    }).pipe(Effect.provide(platform)),
  );

  it.live("maps an unknown response error tag to Defect without detail", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const server = yield* NodeSocketServer.make({ path: `${dataDir}/forman.sock` });
      yield* Effect.forkScoped(
        server.run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              yield* lines(reader).pipe(
                Stream.take(1),
                Stream.runForEach(() =>
                  writer.write('{"id":1,"error":{"tag":"FutureError","detail":"private"}}\n'),
                ),
              );
            }),
          ),
        ),
      );
      const error = yield* Effect.flip(ping(dataDir));
      assert.instanceOf(error, Defect);
      assert.isUndefined(detailFor(error));
    }).pipe(Effect.provide(platform)),
  );

  it.live("answers malformed lines with Usage and continues on the same connection", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      yield* start(options(dataDir));
      const { writer, responses } = yield* peer(dataDir);
      yield* writer.write(
        'bad json\n{"id":17,"body":{"_tag":"unknown"}}\n{"id":18,"body":{"_tag":"Ping"}}\n',
      );
      const results = yield* Effect.forEach([0, 1, 2], () => Queue.take(responses));
      assert.deepStrictEqual(
        results.find((response) => response.id === 0),
        { id: 0, error: { tag: "Usage" } },
      );
      assert.deepStrictEqual(
        results.find((response) => response.id === 17),
        { id: 17, error: { tag: "Usage" } },
      );
      assert.deepStrictEqual(
        results.find((response) => response.id === 18),
        { id: 18, result: { _tag: "Pong", version: "test", pid: process.pid, build: "test" } },
      );
    }).pipe(Effect.provide(platform)),
  );

  it.effect("exits after the idle limit and cleans up its socket and lock", () =>
    Effect.gen(function* () {
      const observation = yield* observeClosures();
      yield* Effect.gen(function* () {
        const dataDir = yield* temp();
        const running = yield* start(options(dataDir, { idleLimitMs: 1000 }));
        yield* observation.closed;
        yield* TestClock.adjust(2000);
        yield* Fiber.join(running);
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(`${dataDir}/forman.sock`));
        assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
      }).pipe(
        Effect.provide(observation.layer),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.effect("stays while busy and starts a fresh idle period when work ends", () =>
    Effect.gen(function* () {
      const observation = yield* observeClosures();
      yield* Effect.gen(function* () {
        const dataDir = yield* temp();
        const busy = yield* Ref.make(true);
        const running = yield* start(options(dataDir, { busy: Ref.get(busy), idleLimitMs: 1000 }));
        yield* observation.closed;
        yield* TestClock.adjust(5000);
        assert.strictEqual((yield* ping(dataDir))._tag, "Pong");
        yield* observation.closed;
        yield* Ref.set(busy, false);
        yield* TestClock.adjust(2000);
        yield* Fiber.join(running);
      }).pipe(
        Effect.provide(observation.layer),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.effect("stays while a connection is open and idles after it closes", () =>
    Effect.gen(function* () {
      const observation = yield* observeClosures();
      yield* Effect.gen(function* () {
        const dataDir = yield* temp();
        const running = yield* start(options(dataDir, { idleLimitMs: 1000 }));
        yield* observation.closed;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* peer(dataDir);
            yield* connection.writer.write('{"id":9,"body":{"_tag":"Ping"}}\n');
            yield* Queue.take(connection.responses);
            yield* TestClock.adjust(5000);
            assert.strictEqual((yield* ping(dataDir))._tag, "Pong");
            yield* observation.closed;
          }),
        );
        yield* observation.closed;
        yield* TestClock.adjust(2000);
        yield* Fiber.join(running);
      }).pipe(
        Effect.provide(observation.layer),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.live("connect-only fails instead of spawning", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const error = yield* Effect.flip(ping(dataDir));
      assert.instanceOf(error, DaemonUnavailable);
      assert.include(error.detail, "Could not connect");
    }).pipe(Effect.provide(platform)),
  );

  it.live("starts a detached daemon on demand and reaches it after the call scope closes", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const bun = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).string(
        ChildProcess.make("which", ["bun"]),
      );
      const executable = [
        bun.trim(),
        fileURLToPath(new URL("./fixtures/daemon/entry.ts", import.meta.url)),
        dataDir,
      ];
      const result = yield* call({ _tag: "Ping" }, { dataDir }).pipe(
        Effect.provide(host(executable)),
      );
      assert.strictEqual(result._tag, "Pong");
      if (result._tag !== "Pong") return;
      // Wait for the daemon to exit, so its shutdown cleanup finishes before the data directory
      // is removed; otherwise the removal races its socket and lock deletion.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          process.kill(result.pid, "SIGTERM");
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            try {
              process.kill(result.pid, 0);
            } catch {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }),
      );
      assert.deepStrictEqual(yield* ping(dataDir), result);
      assert.strictEqual((yield* call({ _tag: "Status", cwd: "/tmp" }, { dataDir }))._tag, "Ok");
    }).pipe(Effect.provide(platform)),
  );

  it.live("reports a startup deadline when the executable exits without listening", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      const error = yield* Effect.flip(
        call({ _tag: "Ping" }, { dataDir, startupTimeoutMs: 150 }).pipe(
          Effect.provide(host([process.execPath, "-e", "process.exit(0)"])),
        ),
      );
      assert.instanceOf(error, DaemonUnavailable);
      assert.include(error.detail, "within 150 ms");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("bounds a pending connection acquisition within the startup deadline", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp();
      yield* NodeSocketServer.make({ path: `${dataDir}/forman.sock` });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delayed = DaemonSockets.layer({
        connect: (path) =>
          NodeSocket.makeNet({ path }).pipe(
            Effect.map((socket) =>
              Socket.make({
                writer: socket.writer,
                reader: socket.reader.pipe(
                  Effect.tap(() =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                ),
              }),
            ),
          ),
        listen: (path) => NodeSocketServer.make({ path }),
      });
      const pending = yield* Effect.forkChild(
        Effect.flip(
          call(
            { _tag: "Ping" },
            {
              dataDir,
              connectOnly: true,
              startupTimeoutMs: 100,
            },
          ),
        ).pipe(Effect.provide(delayed), Effect.timeout(500)),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(500);
      const error = yield* Fiber.join(pending);
      assert.instanceOf(error, DaemonUnavailable);
      assert.include(error.detail, "100 ms");
    }).pipe(Effect.provide(platform)),
  );
});
