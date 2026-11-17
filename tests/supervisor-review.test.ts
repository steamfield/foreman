import { assert, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem } from "effect";
import { diskOverview } from "../src/core/runs/disk-overview";
import * as Store from "../src/core/runs/store";
import { successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { eventsFixture, eventsPlatform as platform } from "./helpers/events";

const fixture = Effect.fnUntraced(function* (running = false) {
  const f = yield* eventsFixture({
    rules: successfulTurn().rules.map((rule) => ({
      ...rule,
      repeat: true,
      ...(running && rule.method === "turn/start" ? { steps: [] } : {}),
    })),
  });
  yield* f.untilState(running ? "running" : "idle");
  return { ...f, dir: `${f.env.FOREMAN_HOME}/runs/unit` };
});

it.live(
  "Review persists the idle run's timestamp in live and saved views without journal entries",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const before = yield* fs.readFileString(`${f.dir}/events.jsonl`);
      const overview = yield* f.request({ _tag: "Overview" });
      assert(overview._tag === "Overview");
      const start = Date.now();
      expect(yield* f.request({ _tag: "Review", name: f.name })).toMatchObject({ _tag: "Ok" });
      const record = yield* Store.readRun(f.dir);
      assert(record.reviewedAt != null);
      expect(DateTime.toEpochMillis(record.reviewedAt)).toBeGreaterThanOrEqual(start);
      expect(DateTime.toEpochMillis(record.reviewedAt)).toBeLessThanOrEqual(Date.now());
      const live = yield* f.request({ _tag: "Overview" });
      assert(live._tag === "Overview");
      expect(live.version).toBeGreaterThan(overview.version);
      expect(live.runs[0]?.reviewedAt).toEqual(record.reviewedAt);
      expect(yield* fs.readFileString(`${f.dir}/events.jsonl`)).toBe(before);
      yield* f.request({ _tag: "Shutdown" });
      while (yield* fs.exists(`${f.env.FOREMAN_HOME}/foreman.sock`)) yield* Effect.yieldNow;
      expect((yield* diskOverview(f.env.FOREMAN_HOME)).runs[0]?.reviewedAt).toEqual(
        record.reviewedAt,
      );
    }).pipe(Effect.provide(platform)),
);

it.live("Review refuses a running run with its state and preserves its record and journal", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const before = yield* Store.readRun(f.dir);
    const events = yield* Store.readEvents(f.dir, 0);
    const error = yield* f.request({ _tag: "Review", name: f.name }).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "RunConflict",
      detail: expect.stringContaining("running"),
    });
    expect(yield* Store.readRun(f.dir)).toEqual(before);
    expect(yield* Store.readEvents(f.dir, 0)).toEqual(events);
  }).pipe(Effect.provide(platform)),
);

it.live("a follow-up clears reviewedAt in the record and both views", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.request({ _tag: "Review", name: f.name });
    expect((yield* Store.readRun(f.dir)).reviewedAt).toBeTruthy();
    yield* f.request({ _tag: "Followup", name: f.name, message: "Continue." });
    yield* f.untilState("idle");
    expect((yield* Store.readRun(f.dir)).reviewedAt).toBeNull();
    const live = yield* f.request({ _tag: "Overview" });
    assert(live._tag === "Overview");
    expect(live.runs[0]?.reviewedAt).toBeNull();
    expect((yield* diskOverview(f.env.FOREMAN_HOME)).runs[0]?.reviewedAt).toBeNull();
  }).pipe(Effect.provide(platform)),
);
