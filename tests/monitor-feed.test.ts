import { fileURLToPath } from "node:url";
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
  Logger,
  Queue,
  References,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess } from "effect/process";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/config";
import { connection } from "../src/core/monitor/connection";
import { detailFeed } from "../src/core/monitor/detail-feed";
import { monitorFeed, RECONNECT_INITIAL_MS, SAVED_PROBE_MS } from "../src/core/monitor/feed";
import { commandResult } from "../src/core/process";
import { call, probe } from "../src/daemon/client";
import { lines, requestJson } from "../src/daemon/protocol";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { DaemonUnavailable } from "../src/errors";
import { Method } from "../src/schemas/codex";
import { type DaemonRequest, RunName, RunRecord } from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { makeSupervisor } from "../src/supervisor";
import { Scenario } from "./fixtures/fake-app-server/scenario";
import { successfulTurn } from "./fixtures/fake-app-server/scenarios";

const host = {
  name: "foreman",
  version: "test",
  build: "test",
  platform: "node",
  compiled: false,
  executable: [process.execPath],
  pid: process.pid,
};
const platform = Layer.mergeAll(
  NodeServices.layer,
  Host.layer(host),
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
);
const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));
const name = Schema.decodeUnknownSync(RunName)("unit");
const savedRecord = (group: string) =>
  Schema.decodeUnknownSync(RunRecord)({
    name: "saved",
    threadId: null,
    group,
    worktree: "/missing/worktree",
    baseCommit: "abc",
    model: "gpt-6.1-sol",
    effort: "high",
    tier: "fast",
    sandbox: "read-only",
    questionTimeoutMs: 60_000,
    state: "idle",
    turns: 1,
    turnKind: "start",
    activeTurnId: null,
    turnBudgetMs: null,
    turnStartedAt: null,
    restoreSandbox: false,
    tokens: null,
    failure: null,
    warnings: [],
    createdAt: "2026-11-16T12:00:00Z",
    updatedAt: "2026-11-16T12:00:00Z",
  });

const collectFeed = <A, R>(stream: Stream.Stream<A, never, R>) =>
  Effect.gen(function* () {
    const values = yield* Queue.unbounded<A>();
    const sleeps = yield* Queue.unbounded<number>();
    const clock = yield* Clock.Clock;
    const fiber = yield* stream.pipe(
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
    const waiting = (ms: number) =>
      Effect.gen(function* () {
        while ((yield* Queue.take(sleeps)) !== ms) yield* Effect.yieldNow;
      });
    return { next: Queue.take(values), values, fiber, waiting };
  });

const fixture = Effect.fnUntraced(function* (scenario = successfulTurn()) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-feed-" }),
  );
  const home = `${root}/d`;
  const repo = `${root}/repo`;
  const worktree = `${repo}/work/unit`;
  yield* fs.makeDirectory(repo);
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ],
  ]) {
    assert.strictEqual(
      (yield* commandResult(ChildProcess.make("git", args, { cwd: repo }))).code,
      0,
    );
  }
  assert.strictEqual(
    (yield* commandResult(
      ChildProcess.make("git", ["worktree", "add", "-qb", "unit", worktree], { cwd: repo }),
    )).code,
    0,
  );
  const scenarioFile = `${root}/scenario.json`;
  yield* fs.writeFileString(
    scenarioFile,
    Schema.encodeSync(Schema.fromJsonString(Scenario))(scenario),
  );
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    FOREMAN_HOME: home,
    CODEX_HOME: `${root}/codex`,
    CODEX_BIN: fake,
    FAKE_APP_SERVER_SCENARIO: scenarioFile,
  };
  const polling = yield* Queue.unbounded<number>();
  const detailPolling = yield* Queue.unbounded<number | undefined>();
  const launch = Effect.fnUntraced(function* (
    build = "test",
    refuse = false,
    idleLimitMs = 60_000,
  ) {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const supervisor = yield* makeSupervisor().pipe(
      Effect.provide(AppConfig.layer(env)),
      Scope.provide(scope),
    );
    const serving = yield* Effect.raceFirst(
      supervisor.failed,
      daemon({
        dataDir: home,
        version: "test",
        ...supervisor,
        idleLimitMs,
        handler: (body) => {
          if (body._tag === "Overview") {
            if (refuse)
              return Effect.fail(new DaemonUnavailable({ detail: "Overview unsupported" }));
            return (body.after === undefined ? Effect.void : Queue.offer(polling, body.after)).pipe(
              Effect.andThen(supervisor.handler(body)),
            );
          }
          return (
            body._tag === "Detail" ? Queue.offer(detailPolling, body.after) : Effect.void
          ).pipe(Effect.andThen(supervisor.handler(body)));
        },
      }).pipe(Effect.provide(Host.layer({ ...host, build }))),
    ).pipe(Effect.forkIn(scope));
    while (true) {
      const result = yield* probe(home, true).pipe(Effect.result);
      if (result._tag === "Success" && result.success?._tag === "Pong") break;
      yield* Effect.yieldNow;
    }
    return { stop: Scope.close(scope, Exit.void), serving };
  });
  const start = call(
    {
      _tag: "Start",
      name,
      worktree,
      contract: "# Feed task\nDo the work.",
      write: false,
      skipDepsCheck: false,
    },
    { dataDir: home, connectOnly: true },
  );
  const feed = collectFeed(monitorFeed(home));
  return { home, repo, fs, launch, start, feed, polling, detailPolling };
});

it.live(
  "emits Live and updated Live for a real run, then reconnects with its last overview and reads saved runs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const server = yield* f.launch();
      const feed = yield* f.feed;
      const initial = yield* feed.next;
      assert.strictEqual(initial._tag, "Live");
      if (initial._tag !== "Live") return;
      assert.deepStrictEqual(initial.overview.runs, []);
      yield* Queue.take(f.polling);
      yield* f.start;
      let latest = initial;
      while (!latest.overview.runs.some((run) => run.state === "idle")) {
        const update = yield* feed.next;
        assert.strictEqual(update._tag, "Live");
        if (update._tag !== "Live") return;
        latest = update;
      }
      assert.isAbove(latest.overview.version, initial.overview.version);
      assert.strictEqual(latest.overview.runs[0]?.title, "Feed task");
      // Observe a pending long-poll before stopping its daemon.
      while ((yield* Queue.take(f.polling)) !== latest.overview.version) yield* Effect.yieldNow;
      yield* server.stop;
      const reconnecting = yield* feed.next;
      assert.strictEqual(reconnecting._tag, "Reconnecting");
      if (reconnecting._tag !== "Reconnecting") return;
      assert.deepStrictEqual(reconnecting.last, latest.overview);
      const saved = yield* feed.next;
      assert.strictEqual(saved._tag, "Saved");
      if (saved._tag !== "Saved") return;
      assert.strictEqual(saved.reason, "no-daemon");
      assert.strictEqual(saved.overview.runs[0]?.state, "idle");
      assert.strictEqual(saved.overview.runs[0]?.activity?.text, "Created result.txt.");
      assert.isFalse(yield* f.fs.exists(`${f.home}/foreman.sock`));
      yield* Fiber.interrupt(feed.fiber);
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.effect(
  "delivers real supervisor detail and steered events, then falls back after daemon shutdown",
  () =>
    Effect.gen(function* () {
      const scenario = successfulTurn();
      const f = yield* fixture({
        rules: [
          ...scenario.rules.map((rule) =>
            rule.method === Method.turnStart ? { ...rule, steps: [] } : rule,
          ),
          { method: Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } },
        ],
      });
      const server = yield* f.launch();
      yield* f.start;
      const feed = yield* collectFeed(detailFeed(f.home, name));
      const initial = yield* feed.next;
      assert.strictEqual(initial._tag, "Live");
      if (initial._tag !== "Live") return;
      assert.strictEqual(initial.detail.run.name, "unit");
      assert.strictEqual(initial.detail.run.state, "running");
      assert.isFalse(initial.gap);
      assert.isUndefined(yield* Queue.take(f.detailPolling));
      assert.strictEqual(yield* Queue.take(f.detailPolling), initial.detail.version);
      const steered = yield* call(
        { _tag: "Steer", name, message: "Focus on feeds." },
        { dataDir: f.home, connectOnly: true },
      );
      assert.strictEqual(steered._tag, "Accepted");
      const update = yield* feed.next;
      assert.strictEqual(update._tag, "Live");
      if (update._tag !== "Live") return;
      assert.deepStrictEqual(update.events, [
        {
          seq: (initial.events.at(-1)?.seq ?? 0) + 1,
          at: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          event: { _tag: "Steered", message: "Focus on feeds." },
        },
      ]);
      assert.isFalse(update.gap);
      assert.isAbove(update.detail.version, initial.detail.version);
      while ((yield* Queue.take(f.detailPolling)) !== update.detail.version) yield* Effect.yieldNow;
      yield* server.stop;
      const reconnecting = yield* feed.next;
      assert.strictEqual(reconnecting._tag, "Reconnecting");
      if (reconnecting._tag === "Reconnecting")
        assert.deepStrictEqual(reconnecting.last, update.detail);
      yield* feed.waiting(RECONNECT_INITIAL_MS);
      yield* TestClock.adjust(RECONNECT_INITIAL_MS);
      const saved = yield* feed.next;
      assert.strictEqual(saved._tag, "Saved");
      if (saved._tag === "Saved") {
        assert.strictEqual(saved.reason, "no-daemon");
        assert.strictEqual(saved.detail.run.name, "unit");
        assert.deepStrictEqual(saved.events, []);
      }
      assert.isFalse(yield* f.fs.exists(`${f.home}/foreman.sock`));
      yield* Fiber.interrupt(feed.fiber);
    }).pipe(Effect.provide(platform)),
);

it.effect("keeps a real inactive run's Detail long-poll after an immediate empty event page", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const server = yield* f.launch();
    yield* f.start;
    yield* call(
      { _tag: "Wait", names: [name], all: false, cwd: f.repo, timeoutMs: 60_000 },
      { dataDir: f.home, connectOnly: true },
    );
    const feed = yield* collectFeed(detailFeed(f.home, name));
    const initial = yield* feed.next;
    assert.strictEqual(initial._tag, "Live");
    if (initial._tag !== "Live") return;
    assert.strictEqual(initial.detail.run.state, "idle");
    assert.isUndefined(yield* Queue.take(f.detailPolling));
    assert.strictEqual(yield* Queue.take(f.detailPolling), initial.detail.version);
    yield* TestClock.adjust(15_000);
    assert.deepStrictEqual(yield* feed.next, {
      ...initial,
      receivedAt: 15_000,
      events: [],
    });
    assert.strictEqual(yield* Queue.take(f.detailPolling), initial.detail.version);
    yield* Fiber.interrupt(feed.fiber);
    yield* server.stop;
  }).pipe(Effect.provide(platform)),
);

it.effect("lets a real supervisor daemon idle out while the overview feed is polling", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const server = yield* f.launch("test", false, 1000);
    const feed = yield* f.feed;
    assert.strictEqual((yield* feed.next)._tag, "Live");
    assert.strictEqual(yield* Queue.take(f.polling), 0);
    yield* TestClock.adjust(1100);
    yield* Fiber.join(server.serving);
    assert.isFalse(yield* f.fs.exists(`${f.home}/foreman.sock`));
    assert.strictEqual((yield* feed.next)._tag, "Reconnecting");
    yield* feed.waiting(RECONNECT_INITIAL_MS);
    yield* TestClock.adjust(RECONNECT_INITIAL_MS);
    const saved = yield* feed.next;
    assert.strictEqual(saved._tag, "Saved");
    if (saved._tag === "Saved") {
      assert.strictEqual(saved.reason, "no-daemon");
      assert.deepStrictEqual(saved.overview.runs, []);
    }
    yield* Fiber.interrupt(feed.fiber);
  }).pipe(Effect.provide(platform)),
);

it.effect(
  "does not spawn a daemon, suppresses unchanged saved content, rereads disk, and switches to Live on the ten-second probe",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const feed = yield* f.feed;
      const saved = yield* feed.next;
      assert.strictEqual(saved._tag, "Saved");
      if (saved._tag !== "Saved") return;
      assert.strictEqual(saved.reason, "no-daemon");
      assert.deepStrictEqual(saved.overview.runs, []);
      assert.strictEqual(saved.nextProbeAt - saved.receivedAt, SAVED_PROBE_MS);
      for (let i = 0; i < 2; i++) {
        yield* feed.waiting(SAVED_PROBE_MS);
        yield* TestClock.adjust(SAVED_PROBE_MS);
      }
      yield* feed.waiting(SAVED_PROBE_MS);
      assert.strictEqual(yield* Queue.size(feed.values), 0);
      assert.isFalse(yield* f.fs.exists(f.home));
      const dir = `${f.home}/runs/saved`;
      yield* f.fs.makeDirectory(dir, { recursive: true });
      yield* f.fs.writeFileString(
        `${dir}/run.json`,
        Schema.encodeSync(Schema.fromJsonString(RunRecord))(savedRecord(f.repo)),
      );
      yield* TestClock.adjust(SAVED_PROBE_MS);
      const changed = yield* feed.next;
      assert.strictEqual(changed._tag, "Saved");
      if (changed._tag !== "Saved") return;
      assert.deepStrictEqual(
        changed.overview.runs.map((run) => run.name),
        ["saved"],
      );
      assert.isFalse(yield* f.fs.exists(`${f.home}/foreman.sock`));
      yield* feed.waiting(SAVED_PROBE_MS);
      const server = yield* f.launch();
      yield* TestClock.adjust(SAVED_PROBE_MS);
      assert.strictEqual((yield* feed.next)._tag, "Live");
      yield* server.stop;
      const reconnecting = yield* feed.next;
      assert.strictEqual(reconnecting._tag, "Reconnecting");
      if (reconnecting._tag !== "Reconnecting") return;
      assert.strictEqual(
        reconnecting.retryAt - (yield* Clock.currentTimeMillis),
        RECONNECT_INITIAL_MS,
      );
      yield* feed.waiting(RECONNECT_INITIAL_MS);
      yield* TestClock.adjust(RECONNECT_INITIAL_MS);
      assert.strictEqual((yield* feed.next)._tag, "Saved");
      yield* Fiber.interrupt(feed.fiber);
    }).pipe(Effect.provide(platform)),
);

const protocolPeers = [
  "undecodable",
  "permission-denied",
  "schema-error",
  "defect",
  "closed",
  "other-overview-build",
  "stalled",
  "legacy",
] as const;
it.effect.each(protocolPeers)(
  "handles a %s protocol peer without failing the stream or misclassifying the connection",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.makeDirectory(f.home);
      const listener = yield* NodeSocketServer.make({ path: `${f.home}/foreman.sock` });
      const overviewEntered = yield* Deferred.make<void>();
      const pings = yield* Queue.unbounded<void>();
      const requests = yield* Queue.unbounded<DaemonRequest>();
      let connections = 0;
      let peerPid = process.pid;
      if (kind === "legacy")
        yield* f.fs.writeFileString(`${f.home}/daemon.lock`, JSON.stringify({ pid: peerPid }));
      const serving = yield* listener
        .run((socket) =>
          Effect.gen(function* () {
            connections += 1;
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            yield* lines(reader).pipe(
              Stream.runForEach((line) =>
                Effect.gen(function* () {
                  const request = yield* Schema.decodeUnknownEffect(requestJson)(line);
                  yield* Queue.offer(requests, request);
                  if (kind === "closed") {
                    yield* writer.write(new Socket.CloseEvent());
                    return;
                  }
                  if (request.body._tag === "Overview" && kind === "stalled") {
                    yield* Deferred.succeed(overviewEntered, undefined);
                    return yield* Effect.never;
                  }
                  if (
                    request.body._tag === "Overview" &&
                    (kind === "permission-denied" || kind === "schema-error" || kind === "defect")
                  ) {
                    const tags = {
                      "permission-denied": "PermissionDenied",
                      "schema-error": "SchemaError",
                      defect: "Defect",
                    };
                    yield* writer.write(
                      `${JSON.stringify({ id: request.id, error: { tag: tags[kind], detail: "Overview failed" } })}\n`,
                    );
                    return;
                  }
                  let result: unknown;
                  if (request.body._tag === "Ping") {
                    yield* Queue.offer(pings, undefined);
                    result = {
                      _tag: "Pong",
                      version: "test",
                      build: kind === "legacy" ? "old" : "test",
                      pid: peerPid,
                    };
                  } else if (kind === "other-overview-build")
                    result = {
                      _tag: "Overview",
                      version: 0,
                      daemon: { version: "test", build: "old", startedAt: "2026-11-16T12:00:00Z" },
                      runs: [],
                    };
                  else result = { _tag: "Overview", version: "not-a-number" };
                  yield* writer.write(`${JSON.stringify({ id: request.id, result })}\n`);
                }),
              ),
            );
          }).pipe(
            Effect.scoped,
            Effect.catchTag("SocketError", (error) =>
              error.reason._tag === "SocketCloseError" ? Effect.void : Effect.fail(error),
            ),
          ),
        )
        .pipe(Effect.forkScoped);
      const feed = yield* f.feed;
      if (kind === "other-overview-build" || kind === "legacy") {
        const value = yield* feed.next;
        assert.strictEqual(value._tag, "Saved");
        if (value._tag !== "Saved") return;
        assert.strictEqual(value.reason, "outdated");
        if (kind === "legacy") {
          yield* Queue.take(pings);
          for (let i = 0; i < 3; i++) {
            yield* feed.waiting(SAVED_PROBE_MS);
            yield* TestClock.adjust(SAVED_PROBE_MS);
          }
          yield* feed.waiting(SAVED_PROBE_MS);
          assert.strictEqual(connections, 1);
          assert.strictEqual(yield* Queue.size(feed.values), 0);
          // Rewriting the same PID is not a replacement, even if the lock's mtime changes.
          yield* f.fs.writeFileString(
            `${f.home}/daemon.lock.tmp`,
            JSON.stringify({ pid: peerPid }),
          );
          yield* f.fs.rename(`${f.home}/daemon.lock.tmp`, `${f.home}/daemon.lock`);
          yield* TestClock.adjust(SAVED_PROBE_MS);
          yield* feed.waiting(SAVED_PROBE_MS);
          assert.strictEqual(connections, 1);
          peerPid += 1;
          yield* f.fs.writeFileString(
            `${f.home}/daemon.lock.tmp`,
            JSON.stringify({ pid: peerPid }),
          );
          yield* f.fs.rename(`${f.home}/daemon.lock.tmp`, `${f.home}/daemon.lock`);
          yield* TestClock.adjust(SAVED_PROBE_MS);
          yield* Queue.take(pings);
          assert.strictEqual(connections, 2);
        }
      } else if (kind === "stalled") {
        yield* Deferred.await(overviewEntered);
        yield* TestClock.adjust(20_000);
        assert.strictEqual(yield* Queue.size(feed.values), 1);
        assert.strictEqual((yield* feed.next)._tag, "Reconnecting");
      } else {
        for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
          const value = yield* feed.next;
          assert.strictEqual(value._tag, "Reconnecting");
          if (value._tag !== "Reconnecting") return;
          assert.strictEqual(value.last, null);
          assert.strictEqual(value.retryAt - (yield* Clock.currentTimeMillis), delay);
          yield* TestClock.adjust(delay);
        }
      }
      yield* Fiber.interrupt(feed.fiber);
      yield* Fiber.interrupt(serving);
      const received = yield* Queue.takeAll(requests);
      assert.isNotEmpty(received);
      for (const request of received) assert.strictEqual(request.passive, true);
      assert.deepStrictEqual(
        received.slice(0, kind === "closed" || kind === "legacy" ? 1 : 2).map((r) => r.body),
        kind === "closed" || kind === "legacy"
          ? [{ _tag: "Ping" }]
          : [{ _tag: "Ping" }, { _tag: "Overview" }],
      );
    }).pipe(Effect.provide(platform)),
);

it.effect("logs a handled projection defect at error level with its diagnostic context", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const dir = `${f.home}/runs/saved`;
    yield* f.fs.makeDirectory(dir, { recursive: true });
    yield* f.fs.writeFileString(
      `${dir}/run.json`,
      Schema.encodeSync(Schema.fromJsonString(RunRecord))({
        ...savedRecord(f.repo),
        state: "waiting",
        questionTimeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    );
    yield* f.fs.writeFileString(
      `${dir}/questions.jsonl`,
      `${JSON.stringify({
        _tag: "Asked",
        id: "q1",
        turn: 1,
        kind: "blocked",
        question: "Help?",
        at: "2026-11-16T12:00:00Z",
      })}\n`,
    );
    const errors: { level: string; annotations: Readonly<Record<string, unknown>> }[] = [];
    const logger = Logger.make((input) =>
      errors.push({
        level: input.logLevel,
        annotations: input.fiber.getRef(References.CurrentLogAnnotations),
      }),
    );
    const value = yield* monitorFeed(f.home).pipe(
      Stream.runHead,
      Effect.provide(Logger.layer([logger])),
    );
    assert.strictEqual(value._tag, "Some");
    if (value._tag === "Some") assert.strictEqual(value.value._tag, "Reconnecting");
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0]?.level, "Error");
    assert.strictEqual(errors[0]?.annotations.reasonTag, "Defect");
    assert.isString(errors[0]?.annotations.trace);
  }).pipe(Effect.provide(platform)),
);

it.effect.each(["other-build", "refused"] as const)(
  "handles %s without stopping or replacing the daemon",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const server = yield* f.launch(kind === "other-build" ? "old" : "test", kind === "refused");
      const feed = yield* f.feed;
      const saved = yield* feed.next;
      if (kind === "refused") {
        assert.strictEqual(saved._tag, "Reconnecting");
        yield* Fiber.interrupt(feed.fiber);
        yield* server.stop;
        return;
      }
      assert.strictEqual(saved._tag, "Saved");
      if (saved._tag !== "Saved") return;
      assert.strictEqual(saved.reason, "outdated");
      assert.deepStrictEqual(saved.overview.runs, []);
      assert.isTrue(yield* f.fs.exists(`${f.home}/foreman.sock`));
      yield* feed.waiting(SAVED_PROBE_MS);
      const dir = `${f.home}/runs/saved`;
      yield* f.fs.makeDirectory(dir, { recursive: true });
      yield* f.fs.writeFileString(
        `${dir}/run.json`,
        Schema.encodeSync(Schema.fromJsonString(RunRecord))(savedRecord(f.repo)),
      );
      yield* TestClock.adjust(SAVED_PROBE_MS);
      const changed = yield* feed.next;
      assert.strictEqual(changed._tag, "Saved");
      if (changed._tag === "Saved") {
        assert.strictEqual(changed.reason, "outdated");
        assert.strictEqual(changed.overview.runs[0]?.name, "saved");
      }
      const pong = yield* probe(f.home, true);
      assert.strictEqual(pong?._tag, "Pong");
      if (pong?._tag !== "Pong") return;
      assert.strictEqual(pong.build, kind === "other-build" ? "old" : "test");
      yield* feed.waiting(SAVED_PROBE_MS);
      yield* server.stop;
      yield* TestClock.adjust(SAVED_PROBE_MS);
      const absent = yield* feed.next;
      assert.strictEqual(absent._tag, "Saved");
      if (absent._tag === "Saved") assert.strictEqual(absent.reason, "no-daemon");
      yield* Fiber.interrupt(feed.fiber);
    }).pipe(Effect.provide(platform)),
);

it.effect.each(["missing", "corrupt", "unreadable"] as const)(
  "probes a stale outdated socket when daemon.lock is %s",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const server = yield* f.launch("old");
      const watch = connection(f.home, host.build);
      assert.strictEqual(yield* watch.check, "outdated");
      // Move the socket before shutdown so closing the listener leaves its inode behind.
      yield* f.fs.rename(`${f.home}/foreman.sock`, `${f.home}/abandoned.sock`);
      yield* server.stop;
      yield* f.fs.rename(`${f.home}/abandoned.sock`, `${f.home}/foreman.sock`);
      if (kind === "corrupt") yield* f.fs.writeFileString(`${f.home}/daemon.lock`, "invalid");
      if (kind === "unreadable") yield* f.fs.makeDirectory(`${f.home}/daemon.lock`);
      assert.strictEqual(yield* watch.check, "no-daemon");
    }).pipe(Effect.provide(platform)),
);
