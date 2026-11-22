import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { AppConfig } from "../src/config";
import * as Store from "../src/core/runs/store";
import type { Inbound, ProviderConnection } from "../src/providers/contract";
import { RunRecord } from "../src/schemas/daemon";
import type { ProviderId } from "../src/schemas/provider";
import { Host } from "../src/services/host";
import { makeConnections } from "../src/supervisor/connections";
import { handleNotification } from "../src/supervisor/notifications";
import { makeRegistry } from "../src/supervisor/registry";
import { makeTurns } from "../src/supervisor/turns";

const baseRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
  readFileSync(new URL("./fixtures/runs/run.json", import.meta.url), "utf8"),
);

// The provider's child process is the third party here; nothing in these cases calls it.
const unusedConnection: ProviderConnection = {
  provider: "agy",
  generation: Symbol("test"),
  inbound: Stream.empty,
  questions: Stream.empty,
  termination: Effect.never,
  open: () => Effect.die("unused"),
  nameSession: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  isLoaded: () => true,
  startTurn: () => Effect.die("unused"),
  steer: () => Effect.die("unused"),
  interrupt: () => Effect.die("unused"),
  ask: () => Effect.die("unused"),
  hookTrust: () => Effect.die("unused"),
};

const services = Layer.mergeAll(
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
);

const facts = { hookEvents: false, displayName: "agy", hookBypassMessage: () => "unused" };

/**
 * An idle run, with the supervisor pieces that apply its messages. A run loaded as active
 * would be recovered as lost, since no provider connection survived.
 */
const setup = Effect.fnUntraced(function* (provider: ProviderId) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const worktree = path.join(home, "worktree");
  yield* fs.makeDirectory(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const record: RunRecord = {
    ...baseRecord,
    provider,
    worktree,
    state: "idle",
    activeTurnId: null,
  };
  const dir = yield* Store.createRun(home, record, "contract");
  const config = yield* AppConfig.pipe(
    Effect.provide(AppConfig.layer({ HOME: home, FOREMAN_HOME: home })),
  );
  const registry = yield* makeRegistry(home);
  const connections = yield* makeConnections(
    config,
    "test",
    registry,
    () => Effect.void,
    () => Effect.void,
  );
  const turns = yield* makeTurns(registry, connections, config);
  const run = yield* registry.lookup(record.name);
  const apply = (inbound: Inbound) =>
    handleNotification(registry, turns, run, unusedConnection, facts, inbound);
  const rawLog = path.join(dir, Store.rawLogName(provider));
  const readRaw = fs
    .exists(rawLog)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? fs.readFileString(rawLog) : Effect.succeed("(no raw log)"),
      ),
    );
  const journaled = Store.readEvents(dir).pipe(
    Effect.map((page) => page.events.map((entry) => entry.event)),
  );
  return { run, apply, readRaw, journaled };
});

it.effect("a message with no events reaches only the raw log", () =>
  Effect.gen(function* () {
    const { run, apply, readRaw, journaled } = yield* setup("agy");
    const before = { record: run.record, events: yield* journaled };

    const raw = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-a" } };
    yield* apply({ session: "thread-a", method: "session/update", raw, events: [] });

    // The store stamps its format version on every raw line.
    expect(
      (yield* readRaw)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ formatVersion: 1, ...raw }]);
    expect(yield* journaled).toEqual(before.events);
    expect(run.record).toEqual(before.record);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("a synthesized message with raw null journals its events without a raw log line", () =>
  Effect.gen(function* () {
    const { run, apply, readRaw, journaled } = yield* setup("agy");
    const before = yield* journaled;

    yield* apply({
      session: "thread-a",
      method: "session/prompt",
      raw: null,
      events: [{ _tag: "TurnStarted", turn: "t1" }],
    });

    expect(yield* readRaw).toBe("(no raw log)");
    expect(yield* journaled).toEqual([
      ...before,
      { _tag: "TurnStarted", turn: 2, kind: "followup" },
    ]);
    expect(run.record.state).toBe("idle");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
