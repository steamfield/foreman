import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  OVERVIEW_REQUEST_TIMEOUT_MS,
  passiveDetail,
  passiveEvents,
  probe,
} from "../src/daemon/client";
import { type DaemonOptions, daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { RunName } from "../src/schemas/daemon";
import { Host } from "../src/services/host";

const name = Schema.decodeUnknownSync(RunName)("unit");
const platform = Layer.mergeAll(
  NodeServices.layer,
  Host.layer({
    name: "foreman",
    version: "test",
    build: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
);
const clients = [
  {
    tag: "Detail",
    read: (home: string) => passiveDetail(home, name, 7).pipe(Effect.asVoid),
    timeout: OVERVIEW_REQUEST_TIMEOUT_MS,
  },
  {
    tag: "Events",
    read: (home: string) => passiveEvents(home, name, 7, 1000).pipe(Effect.asVoid),
    timeout: 6000,
  },
];

const start = Effect.fnUntraced(function* (
  handler: DaemonOptions["handler"],
  idleLimitMs = 60_000,
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-detail-" });
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const running = yield* daemon({
    dataDir: home,
    version: "test",
    handler,
    idleLimitMs,
    busy: Effect.succeed(false),
  }).pipe(Effect.forkIn(scope));
  while (true) {
    const ready = yield* probe(home, true).pipe(Effect.result);
    if (ready._tag === "Success" && ready.success !== null) break;
    yield* Effect.yieldNow;
  }
  return { home, running, stop: Scope.close(scope, Exit.void) };
});

it.effect.each(clients)(
  "passive $tag maps a closed real daemon socket to DaemonUnavailable",
  ({ tag, read }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const server = yield* start((body) => {
        assert.strictEqual(body._tag, tag);
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      });
      const pending = yield* read(server.home).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* server.stop;
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "DaemonUnavailable");
    }).pipe(Effect.provide(platform)),
);

it.effect.each(clients)(
  "passive $tag times out an unresponsive real daemon",
  ({ tag, read, timeout }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const server = yield* start((body) => {
        assert.strictEqual(body._tag, tag);
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      });
      const pending = yield* read(server.home).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(timeout - 1);
      assert.isUndefined(pending.pollUnsafe());
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert(result.failure._tag === "DaemonUnavailable");
        assert.match(result.failure.detail ?? "", /timed out/);
      }
    }).pipe(Effect.provide(platform)),
);

it.effect.each(clients)(
  "passive $tag sends the envelope that allows idle exit while polling",
  ({ tag, read }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const server = yield* start((body) => {
        assert.strictEqual(body._tag, tag);
        return Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        );
      }, 1000);
      yield* TestClock.adjust(900);
      const pending = yield* read(server.home).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(200);
      yield* Fiber.join(server.running);
      yield* Deferred.await(cancelled);
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "DaemonUnavailable");
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(`${server.home}/foreman.sock`));
      assert.isFalse(yield* fs.exists(`${server.home}/daemon.lock`));
    }).pipe(Effect.provide(platform)),
);
