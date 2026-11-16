import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import {
  OVERVIEW_REQUEST_TIMEOUT_MS,
  passiveDetail,
  passiveEvents,
  passiveOverview,
  probe,
} from "../src/daemon/client";
import { lines, requestJson } from "../src/daemon/protocol";
import { type DaemonOptions, daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { type DaemonRequest, type DaemonRequestBody, RunName } from "../src/schemas/daemon";
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
    body: { _tag: "Detail", name, after: 7 } satisfies DaemonRequestBody,
    read: (home: string) =>
      passiveDetail(home, name, 7).pipe(
        Effect.map((result): string | null => result?._tag ?? null),
      ),
    timeout: OVERVIEW_REQUEST_TIMEOUT_MS,
  },
  {
    tag: "Events",
    body: { _tag: "Events", name, after: 7, waitMs: 1000 } satisfies DaemonRequestBody,
    read: (home: string) =>
      passiveEvents(home, name, 7, 1000).pipe(
        Effect.map((result): string | null => result?._tag ?? null),
      ),
    timeout: 6000,
  },
  {
    tag: "Overview",
    body: { _tag: "Overview", after: 7 } satisfies DaemonRequestBody,
    read: (home: string) =>
      passiveOverview(home, 7).pipe(Effect.map((result): string | null => result?._tag ?? null)),
    timeout: OVERVIEW_REQUEST_TIMEOUT_MS,
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

const refused = "Request not understood; daemon build old. The command was not accepted.";
const replies = [
  {
    kind: "legacy refusal",
    response: { error: { tag: "DaemonUnavailable", detail: refused } },
    unsupported: true,
  },
  {
    kind: "permission error",
    response: { error: { tag: "PermissionDenied", detail: refused } },
    unsupported: false,
  },
  {
    kind: "projection error",
    response: { error: { tag: "SchemaError", detail: "Detail failed" } },
    unsupported: false,
  },
  { kind: "internal defect", response: { error: { tag: "Defect" } }, unsupported: false },
  {
    kind: "unavailable error",
    response: { error: { tag: "DaemonUnavailable", detail: "Read failed" } },
    unsupported: false,
  },
  {
    kind: "malformed result",
    response: { result: { _tag: "Detail", version: "invalid" } },
    unsupported: false,
  },
  { kind: "unexpected result", response: { result: { _tag: "Ok" } }, unsupported: false },
];

it.effect.each(clients.flatMap((client) => replies.map((reply) => ({ ...client, ...reply }))))(
  "passive $tag classifies a $kind",
  ({ body, read, response, unsupported }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-reply-" });
      const listener = yield* NodeSocketServer.make({ path: `${home}/foreman.sock` });
      const requests = yield* Queue.unbounded<DaemonRequest>();
      const serving = yield* listener
        .run((socket) =>
          Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              yield* lines(reader).pipe(
                Stream.runForEach((line) =>
                  Schema.decodeUnknownEffect(requestJson)(line).pipe(
                    Effect.flatMap((request) => Queue.offer(requests, request)),
                    Effect.andThen(writer.write(`${JSON.stringify({ id: 1, ...response })}\n`)),
                  ),
                ),
              );
            }),
          ),
        )
        .pipe(Effect.forkScoped);
      const result = yield* read(home).pipe(Effect.result);
      assert.deepStrictEqual(yield* Queue.take(requests), { id: 1, passive: true, body });
      if (unsupported) {
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success") assert.isNull(result.success);
      } else {
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "DaemonUnavailable");
      }
      yield* Fiber.interrupt(serving);
    }).pipe(Effect.provide(platform)),
);

it.effect("passive Events sends an explicit page limit", () =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<DaemonRequestBody>();
    const server = yield* start((body) =>
      Queue.offer(requests, body).pipe(
        Effect.as({ _tag: "Events", events: [], next: 7, gap: false }),
      ),
    );
    assert.deepStrictEqual(yield* passiveEvents(server.home, name, 7, 1000, 3), {
      _tag: "Events",
      events: [],
      next: 7,
      gap: false,
    });
    assert.deepStrictEqual(yield* Queue.take(requests), {
      _tag: "Events",
      name,
      after: 7,
      waitMs: 1000,
      limit: 3,
    });
  }).pipe(Effect.provide(platform)),
);

it.effect.each(clients)(
  "passive $tag maps a closed real daemon socket to DaemonUnavailable",
  ({ body: expected, read }) =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DaemonRequestBody>();
      const server = yield* start((body) =>
        Queue.offer(requests, body).pipe(Effect.andThen(Effect.never)),
      );
      const pending = yield* read(server.home).pipe(Effect.result, Effect.forkChild);
      assert.deepStrictEqual(yield* Queue.take(requests), expected);
      yield* server.stop;
      const result = yield* Fiber.join(pending);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "DaemonUnavailable");
    }).pipe(Effect.provide(platform)),
);

it.effect.each(clients)(
  "passive $tag times out an unresponsive real daemon",
  ({ body: expected, read, timeout }) =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DaemonRequestBody>();
      const server = yield* start((body) =>
        Queue.offer(requests, body).pipe(Effect.andThen(Effect.never)),
      );
      const pending = yield* read(server.home).pipe(Effect.result, Effect.forkChild);
      assert.deepStrictEqual(yield* Queue.take(requests), expected);
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
  ({ body: expected, read }) =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DaemonRequestBody>();
      const cancelled = yield* Deferred.make<void>();
      const server = yield* start(
        (body) =>
          Queue.offer(requests, body).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          ),
        1000,
      );
      yield* TestClock.adjust(900);
      const pending = yield* read(server.home).pipe(Effect.result, Effect.forkChild);
      assert.deepStrictEqual(yield* Queue.take(requests), expected);
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
