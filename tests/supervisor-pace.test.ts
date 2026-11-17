import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as Store from "../src/core/runs/store";
import { RunName, type RunRecord } from "../src/schemas/daemon";
import { PACE_MINUTES } from "../src/schemas/monitor";
import { overview, projectRun } from "../src/supervisor/overview";
import { advancePace, countPace, emptyPace } from "../src/supervisor/pace";
import { makeRegistry } from "../src/supervisor/registry";

const minute = 60_000;
const metadata = { version: "test", build: "test", startedAt: DateTime.makeUnsafe(0) };
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const dir = `${home}/runs/unit`;
  yield* fs.makeDirectory(dir, { recursive: true });
  const record: RunRecord = {
    name: Schema.decodeUnknownSync(RunName)("unit"),
    threadId: null,
    group: "/repo",
    worktree: "/repo/work",
    baseCommit: "base",
    model: "model",
    effort: "high",
    tier: "priority",
    sandbox: "read-only",
    questionTimeoutMs: 1000,
    state: "idle",
    turns: 0,
    turnKind: null,
    activeTurnId: null,
    turnBudgetMs: null,
    turnStartedAt: null,
    restoreSandbox: false,
    tokens: null,
    failure: null,
    warnings: [],
    createdAt: metadata.startedAt,
    updatedAt: metadata.startedAt,
  };
  yield* Store.writeRun(dir, record);
  const registry = yield* makeRegistry(home);
  return { home, registry, run: yield* registry.lookup(record.name) };
});

it.effect("buckets feed events oldest first, excluding tokens, Other and expired events", () =>
  Effect.gen(function* () {
    const { registry, run, home } = yield* fixture();
    for (const time of [0, minute, 11 * minute, 12 * minute, 12 * minute + 1]) {
      yield* TestClock.setTime(time);
      yield* registry.event(run, { _tag: "FileChange", paths: [] });
    }
    yield* registry.event(run, {
      _tag: "TokenUsage",
      totals: { input: 1, output: 1, cachedInput: 0, reasoningOutput: 0 },
    });
    yield* registry.event(run, { _tag: "Other", method: "ignored" });
    const expected = [1, ...Array(PACE_MINUTES - 3).fill(0), 1, 2];
    expect(projectRun(run, "repo", 12 * minute + 1).pace).toEqual(expected);
    const recovered = yield* makeRegistry(home);
    expect(
      projectRun(yield* recovered.lookup(run.record.name), "repo", 12 * minute + 1).pace,
    ).toEqual(expected);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "slides pace and wakes an overview waiter once at the minute boundary without events",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(12 * minute + minute / 2);
      const { registry, run } = yield* fixture();
      yield* registry.event(run, { _tag: "FileChange", paths: ["a.ts"] });
      const initial = yield* overview(registry, metadata, { _tag: "Overview" });
      expect(initial.runs[0]?.pace).toEqual([...Array(PACE_MINUTES - 1).fill(0), 1]);
      const pending = yield* overview(registry, metadata, {
        _tag: "Overview",
        after: initial.version,
        timeoutMs: minute,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(minute / 2 - 1);
      expect(registry.version).toBe(initial.version);
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(251);
      const next = yield* Fiber.join(pending);
      expect(next.runs[0]?.pace).toEqual([...Array(PACE_MINUTES - 2).fill(0), 1, 0]);
      expect(next.version).toBe(initial.version + 1);
      yield* TestClock.adjust(1000);
      expect((yield* overview(registry, metadata, { _tag: "Overview" })).version).toBe(
        next.version,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("includes state transitions appended through registry.state in pace", () =>
  Effect.gen(function* () {
    const { registry, run } = yield* fixture();
    yield* registry.state(run, "running");
    yield* registry.state(run, "idle");
    expect(projectRun(run, "repo", yield* Clock.currentTimeMillis).pace).toEqual([
      ...Array(PACE_MINUTES - 1).fill(0),
      2,
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("counts a late append in its original bucket without rewinding a rolled window", () => {
  const at = 12 * minute;
  const recorded = countPace(emptyPace(at), at);
  const rolled = advancePace(recorded, at + minute);
  const appended = countPace(advancePace(rolled, at), at);
  expect(appended.minute).toBe(13);
  expect(appended.buckets).toEqual([...Array(PACE_MINUTES - 2).fill(0), 2, 0]);
});
