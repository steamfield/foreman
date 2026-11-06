import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { call, shutdown } from "../src/daemon/client";
import { lines, requestJson } from "../src/daemon/protocol";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { DaemonUnavailable } from "../src/errors";
import { main } from "../src/main";
import { AppLayer } from "../src/runtime";
import { RunName } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { successfulTurn } from "./fixtures/fake-app-server/scenarios";

const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "test",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);
const temp = Effect.gen(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "fm-own-",
  });
});
const options = (dataDir: string) => ({
  dataDir,
  version: "test",
  busy: Effect.succeed(false),
  handler: () => Effect.succeed({ _tag: "Ok" as const }),
});
const ready = Effect.fnUntraced(function* (dataDir: string) {
  while (
    (yield* call({ _tag: "Ping" }, { dataDir, connectOnly: true }).pipe(Effect.result))._tag ===
    "Failure"
  )
    yield* Effect.yieldNow;
});

describe("daemon ownership regressions", () => {
  it.effect("bounds shutdown connection acquisition before sending a request", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp;
      const entered = yield* Deferred.make<void>();
      const server = yield* NodeSocketServer.make({ path: `${dataDir}/forman.sock` });
      yield* Effect.forkScoped(server.run(() => Effect.never));
      const observed = DaemonSockets.layer({
        connect: (path) =>
          NodeSocket.makeNet({ path }).pipe(
            Effect.map((socket) =>
              Socket.make({
                writer: socket.writer,
                reader: socket.reader.pipe(
                  Effect.tap(() => Deferred.succeed(entered, undefined)),
                  Effect.andThen(Effect.never),
                ),
              }),
            ),
          ),
        listen: (path) => NodeSocketServer.make({ path }),
      });
      const pending = yield* Effect.forkScoped(
        shutdown(dataDir).pipe(Effect.result, Effect.provide(observed)),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("11 seconds");
      assert.isDefined(
        pending.pollUnsafe(),
        "Shutdown connection acquisition must have a deadline",
      );
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, DaemonUnavailable);
        assert.include(result.failure.detail, "connect");
        assert.include(result.failure.detail, "logs/daemon.jsonl");
      }
    }).pipe(Effect.provide(platform)),
  );

  it.live("confirms advisory ownership is released after the PID record disappears", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp;
      const fs = yield* FileSystem.FileSystem;
      const removed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const checked = yield* Deferred.make<void>();
      const observed: FileSystem.FileSystem = {
        ...fs,
        remove: (path, config) =>
          fs
            .remove(path, config)
            .pipe(
              Effect.tap(() =>
                path === `${dataDir}/daemon.lock`
                  ? Deferred.succeed(removed, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void,
              ),
            ),
      };
      const running = yield* Effect.forkScoped(
        daemon(options(dataDir)).pipe(Effect.provideService(FileSystem.FileSystem, observed)),
      );
      yield* ready(dataDir);
      const clientFs: FileSystem.FileSystem = {
        ...fs,
        exists: (path) =>
          fs
            .exists(path)
            .pipe(
              Effect.tap((exists) =>
                path === `${dataDir}/forman.sock` && !exists
                  ? Deferred.succeed(checked, undefined)
                  : Effect.void,
              ),
            ),
      };
      const stopping = yield* Effect.forkScoped(
        shutdown(dataDir).pipe(Effect.provideService(FileSystem.FileSystem, clientFs)),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      yield* Deferred.await(removed);
      yield* Deferred.await(checked);
      const early = yield* Fiber.join(stopping).pipe(Effect.timeoutOption(100));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      assert.isTrue(yield* Fiber.join(stopping));
      assert.strictEqual(
        early._tag,
        "None",
        "A missing PID record must not confirm released ownership",
      );
      const replacement = yield* Effect.forkScoped(daemon(options(dataDir)));
      yield* ready(dataDir);
      yield* Fiber.interrupt(replacement);
    }).pipe(Effect.provide(platform)),
  );
  it.effect("joins interrupted listener cleanup without advancing the drain clock", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp;
      const running = yield* Effect.forkScoped(daemon(options(dataDir)));
      yield* ready(dataDir);
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(running));
      const exit = yield* TestClock.withLive(
        Fiber.join(stopping).pipe(Effect.timeoutOption("1 second")),
      );
      yield* TestClock.adjust(100);
      yield* Fiber.join(stopping);
      assert.strictEqual(exit._tag, "Some");
    }).pipe(Effect.provide(platform)),
  );
  it.live("the daemon command joins a real supervisor subprocess before releasing ownership", () =>
    Effect.gen(function* () {
      const root = yield* temp;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const repo = `${root}/repo`;
      const dataDir = `${root}/data`;
      yield* fs.makeDirectory(repo);
      const git = (args: string[]) =>
        spawner
          .exitCode(
            ChildProcess.make("git", args, { cwd: repo, stdout: "ignore", stderr: "ignore" }),
          )
          .pipe(Effect.tap((code) => Effect.sync(() => assert.strictEqual(Number(code), 0))));
      yield* git(["init", "-q"]);
      yield* git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ]);
      yield* git(["worktree", "add", "-qb", "unit", `${repo}/work`]);
      yield* fs.writeFileString(`${root}/scenario.json`, JSON.stringify(successfulTurn()));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const children: ChildProcessSpawner.ChildProcessHandle[] = [];
      const observed: typeof spawner = {
        ...spawner,
        spawn: (command) =>
          spawner.spawn(command).pipe(
            Effect.tap((child) => {
              if (!ChildProcess.isStandardCommand(command) || !command.args.includes("--listen"))
                return Effect.void;
              children.push(child);
              return Effect.addFinalizer(() =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              );
            }),
          ),
      };
      const env = {
        HOME: root,
        FORMAN_HOME: dataDir,
        PATH: process.env.PATH ?? "",
        CODEX_BIN: new URL("./fixtures/fake-app-server/main.mjs", import.meta.url).pathname,
        FAKE_APP_SERVER_SCENARIO: `${root}/scenario.json`,
      };
      const running = yield* Effect.forkScoped(
        main(["daemon"]).pipe(
          Effect.provide(
            AppLayer(
              env,
              false,
              async () => {},
              async () => {},
            ),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
        ),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      yield* ready(dataDir);
      const started = yield* call(
        {
          _tag: "Start",
          name: Schema.decodeUnknownSync(RunName)("unit"),
          worktree: `${repo}/work`,
          contract: "Do the work.",
          write: false,
          skipDepsCheck: true,
        },
        { dataDir, connectOnly: true },
      );
      assert.strictEqual(started._tag, "Started");
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(running));
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"));
      yield* daemon(options(dataDir)).pipe(Effect.timeout("1 second"));
      assert.isTrue(yield* fs.exists(`${dataDir}/daemon.lock`));
      assert.strictEqual(children.length, 1);
      for (const child of children) assert.isTrue(yield* child.isRunning);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      for (const child of children) assert.isFalse(yield* child.isRunning);
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
  );
  it.live("ignores a stale PID record belonging to an unrelated live process", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, JSON.stringify({ pid: process.pid }));
      const running = yield* Effect.forkScoped(daemon(options(dataDir)));
      yield* ready(dataDir).pipe(Effect.timeout("1 second"));
      assert.isUndefined(running.pollUnsafe());
    }).pipe(Effect.provide(platform)),
  );

  it.effect("keeps a paused owner exclusive beyond the former reclaim grace period", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dataDir}/daemon.lock`, "");
      yield* fs.utimes(`${dataDir}/daemon.lock`, 0, 0);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let held = false;
      const pause = Effect.suspend(() => {
        if (held) return Effect.void;
        held = true;
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      });
      const observed: FileSystem.FileSystem = {
        ...fs,
        stat: (path) =>
          fs
            .stat(path)
            .pipe(Effect.tap(() => (path === `${dataDir}/daemon.lock` ? pause : Effect.void))),
        writeFileString: (path, text, config) =>
          fs
            .writeFileString(path, text, config)
            .pipe(
              Effect.tap(() =>
                path === `${dataDir}/daemon.lock` && config?.flag !== "wx" ? pause : Effect.void,
              ),
            ),
      };
      const first = yield* Effect.forkScoped(
        daemon(options(dataDir)).pipe(Effect.provideService(FileSystem.FileSystem, observed)),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("31 seconds");
      // Force the old guard's age independently of wall-clock scheduling.
      if (yield* fs.exists(`${dataDir}/daemon.reclaim`))
        for (const marker of yield* fs.readDirectory(`${dataDir}/daemon.reclaim`))
          yield* fs.utimes(`${dataDir}/daemon.reclaim/${marker}`, 0, 0);
      const second = yield* Effect.forkScoped(
        daemon({ ...options(dataDir), version: "contender" }),
      );
      // A contender must finish without waiting for or displacing the paused owner.
      const result = yield* Effect.raceFirst(
        Fiber.join(second).pipe(Effect.as("lost")),
        ready(dataDir).pipe(Effect.as("serving")),
      );
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(result, "lost");
      yield* ready(dataDir);
      assert.isUndefined(first.pollUnsafe());
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(first));
      yield* TestClock.adjust(100);
      yield* Fiber.join(stopping);
    }).pipe(Effect.provide(platform)),
  );

  it.live("holds socket ownership until supervisor cleanup finishes on interruption", () =>
    Effect.gen(function* () {
      const dataDir = yield* temp;
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const running = yield* Effect.forkScoped(
        daemon({
          ...options(dataDir),
          shutdown: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        }),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      yield* ready(dataDir);
      const stopping = yield* Effect.forkScoped(Fiber.interrupt(running));
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      yield* Deferred.await(entered).pipe(Effect.timeout("1 second"));
      assert.isTrue(yield* fs.exists(`${dataDir}/daemon.lock`));
      const connection = yield* Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* NodeSocket.makeNet({ path: `${dataDir}/forman.sock` })).reader;
        }),
      ).pipe(Effect.result);
      assert.strictEqual(connection._tag, "Failure");
      yield* daemon({ ...options(dataDir), version: "replacement" });
      assert.isTrue(yield* fs.exists(`${dataDir}/daemon.lock`));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      assert.isFalse(yield* fs.exists(`${dataDir}/daemon.lock`));
      const replacement = yield* Effect.forkScoped(daemon(options(dataDir)));
      yield* ready(dataDir);
      yield* Fiber.interrupt(replacement);
    }).pipe(Effect.provide(platform)),
  );

  for (const tag of ["Ping", "Shutdown"] as const) {
    it.effect(`bounds a stalled ${tag} exchange without replaying a mutation`, () =>
      Effect.gen(function* () {
        const dataDir = yield* temp;
        const received = yield* Deferred.make<void>();
        const requests: string[] = [];
        const server = yield* NodeSocketServer.make({ path: `${dataDir}/forman.sock` });
        yield* Effect.forkScoped(
          server.run((socket) =>
            Effect.scoped(
              Effect.gen(function* () {
                const reader = yield* socket.reader;
                yield* lines(reader).pipe(
                  Stream.runForEach((line) =>
                    Effect.gen(function* () {
                      requests.push(Schema.decodeUnknownSync(requestJson)(line).body._tag);
                      yield* Deferred.succeed(received, undefined);
                    }),
                  ),
                );
              }),
            ),
          ),
        );
        const work =
          tag === "Shutdown"
            ? shutdown(dataDir).pipe(Effect.asVoid)
            : call(
                { _tag: "Interrupt", name: Schema.decodeUnknownSync(RunName)("unit-a") },
                { dataDir },
              ).pipe(Effect.asVoid);
        const pending = yield* Effect.forkScoped(work.pipe(Effect.result));
        yield* Deferred.await(received);
        yield* TestClock.adjust("11 seconds");
        const outcome = pending.pollUnsafe();
        assert.isDefined(outcome, `${tag} must finish at its deadline`);
        const result = yield* Fiber.join(pending);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, DaemonUnavailable);
          assert.include(result.failure.detail, tag);
          assert.include(result.failure.detail, "logs/daemon.jsonl");
        }
        assert.deepStrictEqual(requests, [tag]);
      }).pipe(Effect.provide(platform)),
    );
  }

  it.live.each(["call", "stop"] as const)(
    "validates socket length before %s connects or spawns",
    (kind) =>
      Effect.gen(function* () {
        const dataDir = `/tmp/${"é".repeat(48)}`;
        const work =
          kind === "stop"
            ? shutdown(dataDir).pipe(Effect.asVoid)
            : call({ _tag: "Ping" }, { dataDir }).pipe(Effect.asVoid);
        const error = yield* Effect.flip(work);
        assert.instanceOf(error, DaemonUnavailable);
        assert.include(error.detail, "104 bytes");
      }).pipe(Effect.provide(platform)),
  );
});
