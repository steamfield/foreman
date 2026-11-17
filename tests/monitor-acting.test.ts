import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { openActing } from "../src/core/monitor/acting";
import { call, probe } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { Host } from "../src/services/host";

const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "foreman",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    executable: ["/must-not-spawn-a-daemon"],
    pid: process.pid,
  }),
);

const start = Effect.fnUntraced(function* (old = false) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-act-" });
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const host = yield* Host;
  const running = yield* daemon({
    dataDir: home,
    version: "test",
    handler: () => Effect.succeed({ _tag: "Ok" }),
    busy: Effect.succeed(false),
    idleLimitMs: 1000,
  }).pipe(
    Effect.provideService(Host, { ...host, build: old ? "old" : host.build }),
    Effect.forkIn(scope),
  );
  while (true) {
    const ready = yield* probe(home, true).pipe(Effect.result);
    if (ready._tag === "Success" && ready.success !== null) break;
    yield* Effect.yieldNow;
  }
  return { home, running, stop: Scope.close(scope, Exit.void) };
});

it.effect("acting without a daemon creates neither a socket nor a daemon owner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-absent-" });
    const error = yield* openActing(home).pipe(Effect.flip);
    assert(error._tag === "DaemonUnavailable");
    expect(error.detail).toContain("foreman status <name>");
    expect(yield* fs.readDirectory(home)).toEqual([]);
  }).pipe(Effect.provide(platform)),
);

it.effect("acting against a refused socket does not replace or remove it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-refused-" });
    const scope = yield* Scope.make();
    yield* NodeSocketServer.make({ path: `${home}/foreman.sock` }).pipe(Scope.provide(scope));
    yield* Scope.close(scope, Exit.void);
    // A stale path can also be left by a failed daemon startup.
    yield* fs.writeFileString(`${home}/foreman.sock`, "stale");
    const error = yield* openActing(home).pipe(Effect.flip);
    assert(error._tag === "DaemonUnavailable");
    expect(error.detail).toContain("foreman status <name>");
    expect(yield* fs.readFileString(`${home}/foreman.sock`)).toBe("stale");
    expect(yield* fs.readDirectory(home)).toEqual(["foreman.sock"]);
  }).pipe(Effect.provide(platform)),
);

it.effect("acting refuses another build and leaves the original daemon running", () =>
  Effect.gen(function* () {
    const server = yield* start(true);
    const before = yield* probe(server.home, true);
    const error = yield* Effect.scoped(openActing(server.home)).pipe(Effect.flip);
    assert(error._tag === "DaemonUnavailable");
    expect(error.detail).toContain("foreman status <name>");
    expect(yield* probe(server.home, true)).toEqual(before);
    assert.isUndefined(server.running.pollUnsafe());
  }).pipe(Effect.provide(platform)),
);

it.effect("acting keeps the daemon alive until its scope closes", () =>
  Effect.gen(function* () {
    const server = yield* start();
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    yield* openActing(server.home).pipe(Scope.provide(scope));
    yield* TestClock.adjust(2500);
    assert.isUndefined(server.running.pollUnsafe());
    expect(yield* probe(server.home, true)).not.toBeNull();
    yield* Scope.close(scope, Exit.void);
    // Drive idle ticks until the server has observed the socket close and exited.
    while (true) {
      yield* TestClock.adjust(100);
      if (server.running.pollUnsafe() !== undefined) break;
      yield* Effect.yieldNow;
    }
    yield* Fiber.join(server.running);
    expect(yield* probe(server.home, true)).toBeNull();
  }).pipe(Effect.provide(platform)),
);

it.effect("acting exposes an unasked daemon shutdown through closed", () =>
  Effect.gen(function* () {
    const server = yield* start();
    const session = yield* openActing(server.home);
    const closed = yield* session.closed.pipe(Effect.forkChild);
    assert.isUndefined(closed.pollUnsafe());
    yield* call({ _tag: "Shutdown" }, { dataDir: server.home, connectOnly: true });
    yield* TestClock.adjust(100);
    yield* Fiber.join(closed);
    yield* Fiber.join(server.running);
  }).pipe(Effect.provide(platform)),
);
