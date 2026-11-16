import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  Clock,
  DateTime,
  Deferred,
  Duration,
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
import { type DetailFeed, detailFeed } from "../src/core/monitor/detail-feed";
import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, SAVED_PROBE_MS } from "../src/core/monitor/feed";
import { diskDetail } from "../src/core/runs/disk-detail";
import * as Store from "../src/core/runs/store";
import { lines, requestJson, responseJson } from "../src/daemon/protocol";
import { DaemonSockets } from "../src/daemon/sockets";
import {
  activeStates,
  type DaemonRequest,
  type DaemonRequestBody,
  RunEvent,
  RunName,
  type RunRecord,
} from "../src/schemas/daemon";
import { Host } from "../src/services/host";

const name = Schema.decodeUnknownSync(RunName)("saved");
const at = DateTime.makeUnsafe("2026-11-16T12:00:00Z");
const record: RunRecord = {
  name,
  threadId: null,
  group: "/repo",
  worktree: "/missing/worktree",
  baseCommit: "abc",
  model: "gpt-6.1-sol",
  effort: "high",
  tier: "fast",
  sandbox: "read-only",
  questionTimeoutMs: 60_000,
  state: "running",
  turns: 1,
  turnKind: "start",
  activeTurnId: null,
  turnBudgetMs: null,
  turnStartedAt: at,
  restoreSandbox: false,
  tokens: null,
  failure: null,
  warnings: [],
  createdAt: at,
  updatedAt: at,
};
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
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-det-" }),
  );
  const dir = `${home}/runs/${name}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* Store.writeRun(dir, record);
  const requests = yield* Queue.unbounded<DaemonRequestBody>();
  const envelopes = yield* Queue.unbounded<DaemonRequest>();
  let version = 1;
  let pid = process.pid;
  let build = "test";
  let mode:
    | "normal"
    | "closed"
    | "missing"
    | "unsupported"
    | "undecodable"
    | "permission-denied"
    | "schema-error"
    | "defect" = "normal";
  let eventChanged = yield* Deferred.make<void>();
  let detailChanged = yield* Deferred.make<void>();
  let activeDetails = 0;
  let maxDetailsWhileDraining = 0;
  const launch = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
    const listener = yield* NodeSocketServer.make({ path: `${home}/foreman.sock` }).pipe(
      Scope.provide(scope),
    );
    const serving = yield* listener
      .run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            yield* lines(reader).pipe(
              Stream.runForEach((line) =>
                Effect.gen(function* () {
                  const request = yield* Schema.decodeUnknownEffect(requestJson)(line);
                  yield* Queue.offer(envelopes, request);
                  const body = request.body;
                  const respond = Effect.gen(function* () {
                    yield* Queue.offer(requests, body);
                    if (mode === "closed") return;
                    if (body._tag === "Ping") {
                      yield* writer.write(
                        `${JSON.stringify({ id: request.id, result: { _tag: "Pong", version: "test", build, pid } })}\n`,
                      );
                      return;
                    }
                    if (mode === "missing") {
                      yield* writer.write(
                        `${JSON.stringify({ id: request.id, error: { tag: "RunNotFound" } })}\n`,
                      );
                      return;
                    }
                    if (mode === "unsupported") {
                      yield* writer.write(
                        `${JSON.stringify({ id: request.id, result: { _tag: "Ok" } })}\n`,
                      );
                      return;
                    }
                    if (mode === "undecodable") {
                      yield* writer.write(
                        `${JSON.stringify({ id: request.id, result: { _tag: "Detail", version: "invalid" } })}\n`,
                      );
                      return;
                    }
                    if (
                      mode === "permission-denied" ||
                      mode === "schema-error" ||
                      mode === "defect"
                    ) {
                      const tags = {
                        "permission-denied": "PermissionDenied",
                        "schema-error": "SchemaError",
                        defect: "Defect",
                      };
                      yield* writer.write(
                        `${JSON.stringify({ id: request.id, error: { tag: tags[mode], detail: "Detail failed" } })}\n`,
                      );
                      return;
                    }
                    if (body._tag === "Detail") {
                      if (body.after === version) {
                        activeDetails += 1;
                        yield* Effect.raceFirst(
                          Deferred.await(detailChanged),
                          Effect.sleep(15_000),
                        ).pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              activeDetails -= 1;
                            }),
                          ),
                        );
                      }
                      const detail = yield* diskDetail(home, name);
                      if (detail === null) return yield* Effect.die("fake peer run is missing");
                      yield* writer.write(
                        `${Schema.encodeSync(responseJson)({ id: request.id, result: { ...detail, version } })}\n`,
                      );
                    } else if (body._tag === "Events") {
                      // A peer's default page size need not match the feed's page size.
                      let page = yield* Store.readEvents(dir, body.after, body.limit ?? 25);
                      if (
                        page.events.length === 0 &&
                        (body.waitMs ?? 0) > 1 &&
                        activeStates.has((yield* Store.readRun(dir)).state)
                      ) {
                        yield* Effect.raceFirst(
                          Deferred.await(eventChanged),
                          Effect.sleep(body.waitMs ?? 0),
                        );
                        page = yield* Store.readEvents(dir, body.after, body.limit ?? 25);
                      }
                      if (page.events.length === 100)
                        maxDetailsWhileDraining = Math.max(maxDetailsWhileDraining, activeDetails);
                      yield* writer.write(
                        `${Schema.encodeSync(responseJson)({ id: request.id, result: page })}\n`,
                      );
                    } else return yield* Effect.die(`unexpected request: ${body._tag}`);
                  });
                  yield* respond.pipe(Effect.forkScoped);
                }),
              ),
            );
          }),
        ).pipe(
          Effect.catchTag("SocketError", (error) =>
            error.reason._tag === "SocketCloseError" ? Effect.void : Effect.fail(error),
          ),
        ),
      )
      .pipe(Effect.forkIn(scope));
    return {
      stop: Scope.close(scope, Exit.void).pipe(
        Effect.andThen(Fiber.await(serving)),
        Effect.andThen(fs.remove(`${home}/foreman.sock`, { force: true })),
      ),
    };
  });
  const feed = Effect.gen(function* () {
    const values = yield* Queue.unbounded<DetailFeed>();
    const sleeps = yield* Queue.unbounded<number>();
    const clock = yield* Clock.Clock;
    const fiber = yield* detailFeed(home, name).pipe(
      Stream.runForEach((value) => Queue.offer(values, value)),
      Effect.provideService(Clock.Clock, {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) =>
          Queue.offer(sleeps, Duration.toMillis(duration)).pipe(
            Effect.andThen(clock.sleep(duration)),
          ),
      }),
      Effect.forkScoped,
    );
    const next = Effect.raceFirst(
      Queue.take(values),
      Fiber.join(fiber).pipe(Effect.andThen(Effect.die("feed ended"))),
    );
    const waiting = (ms: number) =>
      Effect.gen(function* () {
        while ((yield* Queue.take(sleeps)) !== ms) yield* Effect.yieldNow;
      });
    return { next, values, fiber, waiting };
  });
  const seen = (predicate: (body: DaemonRequestBody) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const body = yield* Queue.take(requests);
        if (predicate(body)) return body;
      }
    });
  const append = Effect.gen(function* () {
    const entry = yield* Store.appendEvent(dir, {
      _tag: "AgentMessage",
      text: "new event",
      phase: null,
    });
    yield* Deferred.succeed(eventChanged, undefined);
    eventChanged = yield* Deferred.make<void>();
    return entry;
  });
  return {
    fs,
    home,
    dir,
    launch,
    feed,
    seen,
    requests,
    checkRequests: Effect.gen(function* () {
      const received = yield* Queue.takeAll(envelopes);
      assert.isNotEmpty(received);
      for (const request of received) assert.strictEqual(request.passive, true);
    }),
    append,
    configure: (options: { mode?: typeof mode; build?: string; pid?: number }) => {
      mode = options.mode ?? mode;
      build = options.build ?? build;
      pid = options.pid ?? pid;
    },
    bump: Effect.gen(function* () {
      version += 1;
      yield* Deferred.succeed(detailChanged, undefined);
      detailChanged = yield* Deferred.make<void>();
    }),
    drainingDetails: () => maxDetailsWhileDraining,
  };
});

it.effect("delivers a version-only peer change without repeating events", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const event = yield* f.append;
    const server = yield* f.launch;
    const feed = yield* f.feed;
    const initial = yield* feed.next;
    assert.strictEqual(initial._tag, "Live");
    if (initial._tag !== "Live") return;
    assert.deepStrictEqual(initial.events, [event]);
    yield* f.seen((body) => body._tag === "Detail" && body.after === 1);
    yield* f.bump;
    const changed = yield* feed.next;
    assert.strictEqual(changed._tag, "Live");
    if (changed._tag === "Live") {
      assert.strictEqual(changed.detail.version, 2);
      assert.deepStrictEqual(changed.events, []);
    }
    yield* Fiber.interrupt(feed.fiber);
    yield* server.stop;
    yield* f.checkRequests;
  }).pipe(Effect.provide(platform)),
);

it.effect.each(["Live", "Saved"] as const)(
  "drains more than two %s pages without duplicate events and carries a gap",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const events = Array.from({ length: 205 }, (_, i) => ({
        seq: i + 5,
        at,
        event: { _tag: "Other" as const, method: "test" },
      }));
      yield* f.fs.writeFileString(
        `${f.dir}/events.jsonl`,
        `${events
          .map((event) => Schema.encodeSync(Schema.fromJsonString(RunEvent))(event))
          .join("\n")}\n`,
      );
      const server = kind === "Live" ? yield* f.launch : null;
      const feed = yield* f.feed;
      const pages = [yield* feed.next, yield* feed.next, yield* feed.next];
      assert.deepStrictEqual(
        pages.map((p) => p._tag),
        [kind, kind, kind],
      );
      const live = pages.filter((p) => p._tag === "Live" || p._tag === "Saved");
      assert.deepStrictEqual(
        live.map((p) => p.events.length),
        [100, 100, 5],
      );
      assert.deepStrictEqual(
        live.flatMap((p) => p.events),
        events,
      );
      assert.deepStrictEqual(
        live.map((p) => p.gap),
        [true, false, false],
      );
      assert.strictEqual(f.drainingDetails(), 0);
      assert.deepStrictEqual(
        live.map((p) => p.receivedAt),
        [0, 0, 0],
      );
      yield* Fiber.interrupt(feed.fiber);
      if (server !== null) yield* server.stop;
      if (server !== null) yield* f.checkRequests;
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "reads Saved without a daemon, suppresses identical content including after events, and archives a removed run",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const feed = yield* f.feed;
      const saved = yield* feed.next;
      assert.strictEqual(saved._tag, "Saved");
      if (saved._tag !== "Saved") return;
      assert.strictEqual(saved.reason, "no-daemon");
      assert.deepStrictEqual(saved.events, []);
      assert.strictEqual(saved.nextProbeAt - saved.receivedAt, SAVED_PROBE_MS);
      for (let i = 0; i < 2; i++) {
        yield* feed.waiting(SAVED_PROBE_MS);
        yield* TestClock.adjust(SAVED_PROBE_MS);
      }
      yield* feed.waiting(SAVED_PROBE_MS);
      assert.strictEqual(yield* Queue.size(feed.values), 0);
      const event = yield* f.append;
      yield* TestClock.adjust(SAVED_PROBE_MS);
      const update = yield* feed.next;
      assert.strictEqual(update._tag, "Saved");
      if (update._tag === "Saved") assert.deepStrictEqual(update.events, [event]);
      for (let i = 0; i < 2; i++) {
        yield* feed.waiting(SAVED_PROBE_MS);
        yield* TestClock.adjust(SAVED_PROBE_MS);
      }
      yield* feed.waiting(SAVED_PROBE_MS);
      assert.strictEqual(yield* Queue.size(feed.values), 0);
      assert.isFalse(yield* f.fs.exists(`${f.home}/foreman.sock`));
      assert.deepStrictEqual((yield* f.fs.readDirectory(f.home)).sort(), ["runs"]);
      yield* f.fs.remove(f.dir, { recursive: true });
      yield* TestClock.adjust(SAVED_PROBE_MS);
      assert.strictEqual((yield* feed.next)._tag, "Archived");
      yield* Fiber.interrupt(feed.fiber);
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "stays Saved/outdated without probing an old-build PID, then detects its replacement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.configure({ build: "old" });
      yield* f.fs.writeFileString(`${f.home}/daemon.lock`, JSON.stringify({ pid: process.pid }));
      const server = yield* f.launch;
      const feed = yield* f.feed;
      const saved = yield* feed.next;
      assert.strictEqual(saved._tag, "Saved");
      if (saved._tag === "Saved") assert.strictEqual(saved.reason, "outdated");
      yield* Queue.takeAll(f.requests);
      for (let i = 0; i < 3; i++) {
        yield* feed.waiting(SAVED_PROBE_MS);
        yield* TestClock.adjust(SAVED_PROBE_MS);
      }
      yield* feed.waiting(SAVED_PROBE_MS);
      assert.strictEqual(yield* Queue.size(f.requests), 0);
      assert.strictEqual(yield* Queue.size(feed.values), 0);
      f.configure({ build: "test", mode: "normal", pid: process.pid + 1 });
      yield* f.fs.writeFileString(
        `${f.home}/daemon.lock`,
        JSON.stringify({ pid: process.pid + 1 }),
      );
      yield* TestClock.adjust(SAVED_PROBE_MS);
      assert.strictEqual((yield* feed.next)._tag, "Live");
      yield* Fiber.interrupt(feed.fiber);
      yield* server.stop;
      yield* f.checkRequests;
    }).pipe(Effect.provide(platform)),
);

it.effect.each([
  "unsupported",
  "undecodable",
  "permission-denied",
  "schema-error",
  "defect",
] as const)("reconnects after a same-build %s reply and recovers without a PID change", (mode) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.configure({ mode });
    yield* f.fs.writeFileString(`${f.home}/daemon.lock`, JSON.stringify({ pid: process.pid }));
    const server = yield* f.launch;
    const feed = yield* f.feed;
    const failed = yield* feed.next;
    assert.strictEqual(failed._tag, "Reconnecting");
    if (failed._tag === "Reconnecting") assert.isNull(failed.last);
    f.configure({ mode: "normal" });
    yield* feed.waiting(RECONNECT_INITIAL_MS);
    yield* TestClock.adjust(RECONNECT_INITIAL_MS);
    assert.strictEqual((yield* feed.next)._tag, "Live");
    yield* Fiber.interrupt(feed.fiber);
    yield* server.stop;
    yield* f.checkRequests;
  }).pipe(Effect.provide(platform)),
);

it.effect(
  "backs off to the cap after transport failures and recovers with its cursor and last Detail",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const event = yield* f.append;
      const server = yield* f.launch;
      const feed = yield* f.feed;
      const first = yield* feed.next;
      assert.strictEqual(first._tag, "Live");
      if (first._tag !== "Live") return;
      assert.deepStrictEqual(first.events, [event]);
      yield* f.seen((b) => b._tag === "Events" && (b.waitMs ?? 0) > 1);
      yield* server.stop;
      let retry = yield* feed.next;
      for (const delay of [
        RECONNECT_INITIAL_MS,
        2000,
        4000,
        8000,
        RECONNECT_MAX_MS,
        RECONNECT_MAX_MS,
      ]) {
        assert.strictEqual(retry._tag, "Reconnecting");
        if (retry._tag !== "Reconnecting") return;
        assert.deepStrictEqual(retry.last, first.detail);
        assert.strictEqual(retry.retryAt - (yield* Clock.currentTimeMillis), delay);
        // A corrupt socket peer keeps this a transport error rather than no-daemon.
        const broken = yield* f.launch;
        f.configure({ mode: "closed" });
        yield* feed.waiting(delay);
        const advancing = yield* TestClock.adjust(delay).pipe(Effect.forkScoped);
        yield* f.seen((b) => b._tag === "Ping");
        yield* broken.stop;
        yield* Fiber.join(advancing);
        retry = yield* feed.next;
      }
      f.configure({ mode: "normal" });
      const recovered = yield* f.launch;
      yield* feed.waiting(RECONNECT_MAX_MS);
      yield* TestClock.adjust(RECONNECT_MAX_MS);
      const resumed = yield* feed.next;
      assert.strictEqual(resumed._tag, "Live");
      if (resumed._tag === "Live") assert.deepStrictEqual(resumed.events, []);
      yield* Fiber.interrupt(feed.fiber);
      yield* recovered.stop;
      yield* f.checkRequests;
    }).pipe(Effect.provide(platform)),
);

it.effect("archives a daemon not-found response even while disk data remains", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.configure({ mode: "missing" });
    const server = yield* f.launch;
    const feed = yield* f.feed;
    assert.strictEqual((yield* feed.next)._tag, "Archived");
    assert.isTrue(yield* f.fs.exists(`${f.dir}/run.json`));
    yield* Fiber.interrupt(feed.fiber);
    yield* server.stop;
    yield* f.checkRequests;
  }).pipe(Effect.provide(platform)),
);

it.effect.each(["Saved", "Live"] as const)(
  "restarts the event cursor when a %s run name is reused between reads",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.append;
      yield* f.append;
      const server = kind === "Live" ? yield* f.launch : null;
      const feed = yield* f.feed;
      const first = yield* feed.next;
      assert.strictEqual(first._tag, kind);
      if (first._tag !== "Live" && first._tag !== "Saved") return;
      assert.strictEqual(first.events.length, 2);
      if (kind === "Live") yield* f.seen((b) => b._tag === "Detail" && b.after === 1);
      else yield* feed.waiting(SAVED_PROBE_MS);
      yield* Store.writeRun(f.dir, {
        ...record,
        createdAt: DateTime.makeUnsafe("2026-11-16T12:01:00Z"),
      });
      yield* f.fs.remove(`${f.dir}/events.jsonl`);
      const replacement = yield* f.append;
      if (kind === "Live") yield* f.bump;
      else yield* TestClock.adjust(SAVED_PROBE_MS);
      const next = yield* feed.next;
      assert.strictEqual(next._tag, kind);
      if (next._tag === "Live" || next._tag === "Saved")
        assert.deepStrictEqual(next.events, [replacement]);
      yield* Fiber.interrupt(feed.fiber);
      if (server !== null) yield* server.stop;
      if (server !== null) yield* f.checkRequests;
    }).pipe(Effect.provide(platform)),
);
