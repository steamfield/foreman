import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as Store from "../src/core/runs/store";
import {
  QuestionId,
  QuestionLine,
  RunEvent,
  RunRecord,
  type RunState,
} from "../src/schemas/daemon";

const record = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
  readFileSync(new URL("./fixtures/runs/run.json", import.meta.url), "utf8"),
);

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const worktree = path.join(root, "worktree");
  yield* fs.makeDirectory(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const run = { ...record, worktree };
  const dir = yield* Store.createRun(root, run, "- May change: `src/`\n");
  return { fs, path, root, dir, run };
});

it.effect(
  "creates five start files, round-trips the record and ignores a stray atomic-write temp",
  () =>
    Effect.gen(function* () {
      const { fs, path, dir, run } = yield* setup();
      expect((yield* fs.readDirectory(dir)).sort()).toEqual([
        "baseline.txt",
        "contract.md",
        "events.jsonl",
        "run.json",
        "start-mark",
      ]);
      expect(yield* fs.readFileString(path.join(dir, "contract.md"))).toBe(
        "- May change: `src/`\n",
      );
      expect(yield* Store.readRun(dir)).toEqual(run);
      yield* fs.writeFileString(path.join(dir, "run.json.tmp"), "partially written");
      expect(yield* Store.readRun(dir)).toEqual(run);
      const updated = { ...run, state: "idle" as const };
      yield* Store.writeRun(dir, updated);
      expect(yield* Store.readRun(dir)).toEqual(updated);
      expect(yield* fs.exists(path.join(dir, "run.json.tmp"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rebuilds the registry, reporting corrupt runs and ignoring archives and non-directories",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, run } = yield* setup();
      const corrupt = path.join(root, "runs", "bad");
      yield* fs.makeDirectory(corrupt);
      yield* fs.writeFileString(path.join(corrupt, "run.json"), '{"name":3}');
      yield* fs.makeDirectory(path.join(root, "runs", ".archive"));
      yield* fs.writeFileString(path.join(root, "runs", "stray"), "ignore");
      const result = yield* Store.readAllRuns(root);
      expect(result.runs).toEqual([run]);
      expect(result.skipped).toEqual([
        { name: "bad", reason: expect.stringContaining("SchemaError") },
      ]);
      expect(yield* Store.readAllRuns(path.join(root, "absent"))).toEqual({
        runs: [],
        skipped: [],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("removes incomplete creation on failure so a valid retry can use the same name", () =>
  Effect.gen(function* () {
    const { fs, path, root, run } = yield* setup();
    const dataDir = path.join(root, "retry");
    const invalid = { ...run, failure: { message: "Cannot encode", codexErrorInfo: 1n } };
    expect((yield* Effect.flip(Store.createRun(dataDir, invalid, "contract")))._tag).toBe(
      "SchemaError",
    );
    expect(yield* fs.exists(path.join(dataDir, "runs", run.name))).toBe(false);
    expect(yield* Store.readAllRuns(dataDir)).toEqual({ runs: [], skipped: [] });
    const dir = yield* Store.createRun(dataDir, run, "contract");
    expect(yield* Store.readRun(dir)).toEqual(run);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("archives an inactive run with all its files", () =>
  Effect.gen(function* () {
    const { fs, path, root, dir, run } = yield* setup();
    yield* Store.writeRun(dir, { ...run, state: "idle" });
    yield* TestClock.setTime(1234);
    const target = yield* Store.archiveRun(root, run.name);
    expect(target).toBe(path.join(root, "runs", ".archive", "unit-a-1234"));
    expect(yield* fs.exists(dir)).toBe(false);
    expect((yield* Store.readRun(target)).state).toBe("idle");
    expect(yield* fs.exists(path.join(target, "contract.md"))).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each<RunState>(["starting", "running", "waiting", "unknown"])(
  "refuses to archive active state %s",
  (state) =>
    Effect.gen(function* () {
      const { fs, root, dir, run } = yield* setup();
      yield* Store.writeRun(dir, { ...run, state });
      const error = yield* Effect.flip(Store.archiveRun(root, run.name));
      expect(error).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining(state) });
      expect(yield* fs.exists(dir)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps contiguous event sequences across fresh reads and pages without gaps", () =>
  Effect.gen(function* () {
    const { root, run } = yield* setup();
    const dir = yield* Store.runDirectory(root, run.name);
    yield* TestClock.setTime(1000);
    expect(
      (yield* Store.appendEvent(dir, { _tag: "TurnStarted", turn: 1, kind: "start" })).seq,
    ).toBe(1);
    const freshDir = yield* Store.runDirectory(root, run.name);
    const second = yield* Store.appendEvent(freshDir, {
      _tag: "AgentMessage",
      text: "done",
      phase: null,
    });
    expect(second.seq).toBe(2);
    expect(DateTime.toEpochMillis(second.at)).toBe(yield* Clock.currentTimeMillis);
    yield* Store.appendEvent(freshDir, {
      _tag: "TurnCompleted",
      turn: 1,
      status: "completed",
      failure: null,
    });
    expect(yield* Store.readEvents(dir, 0, 1)).toMatchObject({
      events: [{ seq: 1 }],
      gap: false,
      next: 1,
    });
    expect(yield* Store.readEvents(dir, 1, 1)).toMatchObject({
      events: [{ seq: 2 }],
      gap: false,
      next: 2,
    });
    expect(yield* Store.readEvents(dir, 2, 10)).toMatchObject({
      events: [{ seq: 3 }],
      gap: false,
      next: 3,
    });
    expect(yield* Store.readEvents(dir, 3, 10)).toEqual({
      _tag: "Events",
      events: [],
      gap: false,
      next: 3,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports an on-disk prefix gap and propagates corrupt event lines", () =>
  Effect.gen(function* () {
    const { fs, path, dir } = yield* setup();
    const event = yield* Store.appendEvent(dir, { _tag: "Other", method: "probe" });
    const file = path.join(dir, "events.jsonl");
    yield* fs.writeFileString(
      file,
      `${Schema.encodeSync(Schema.fromJsonString(RunEvent))({ ...event, seq: 5 })}\n`,
    );
    expect(yield* Store.readEvents(dir, 1)).toMatchObject({ gap: true, next: 5 });
    yield* fs.writeFileString(file, "bad\n", { flag: "a" });
    expect((yield* Effect.flip(Store.readEvents(dir)))._tag).toBe("SchemaError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("allocates sequences from only the final record, including a large UTF-8 record", () =>
  Effect.gen(function* () {
    const { fs, path, dir } = yield* setup();
    const file = path.join(dir, "events.jsonl");
    const entry: RunEvent = {
      seq: 41,
      at: DateTime.makeUnsafe(0),
      event: { _tag: "AgentMessage", phase: null, text: "é".repeat(10_000) },
    };
    const encoded = Schema.encodeSync(Schema.fromJsonString(RunEvent))(entry);
    yield* fs.writeFileString(file, `unrecognized historical record\n${encoded}\n`);
    expect((yield* Store.appendEvent(dir, { _tag: "Other", method: "probe" })).seq).toBe(42);
    const last = (yield* fs.readFileString(file)).trim().split("\n").at(-1);
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(RunEvent))(last).seq).toBe(42);
    yield* fs.writeFileString(file, "bad final record\n", { flag: "a" });
    expect(
      (yield* Effect.flip(Store.appendEvent(dir, { _tag: "Other", method: "probe" })))._tag,
    ).toBe("SchemaError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("derives pending questions after answered, auto-answered and cancelled resolutions", () =>
  Effect.gen(function* () {
    const { dir } = yield* setup();
    const at = DateTime.makeUnsafe(0);
    for (let id = 1; id <= 4; id++)
      yield* Store.appendQuestion(dir, {
        _tag: "Asked",
        id: Schema.decodeUnknownSync(QuestionId)(`q${id}`),
        turn: 1,
        kind: "blocked",
        question: `Question ${id}`,
        at,
      });
    for (const [index, resolution] of ["answered", "auto-answered", "cancelled"].entries()) {
      const decoded = Schema.decodeUnknownSync(QuestionLine)({
        _tag: "Resolved",
        id: `q${index + 1}`,
        resolution,
        text: null,
        at: "1970-01-01T00:00:01Z",
      });
      yield* Store.appendQuestion(dir, decoded);
    }
    const lines = yield* Store.readQuestions(dir);
    expect(lines).toHaveLength(7);
    expect(Store.pendingQuestions(lines)).toMatchObject([{ id: "q4", question: "Question 4" }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads the newest available hand-off when the interrupted latest turn has none", () =>
  Effect.gen(function* () {
    const { fs, path, dir } = yield* setup();
    expect(yield* Store.readHandoff(dir, 0)).toEqual({
      handoff: null,
      latestTurnWithoutHandoff: false,
    });
    expect(yield* Store.readHandoff(dir, 1)).toEqual({
      handoff: null,
      latestTurnWithoutHandoff: true,
    });
    yield* Store.writeHandoff(dir, 1, "first");
    yield* Store.writeHandoff(dir, 2, "second");
    expect(yield* fs.readFileString(path.join(dir, "turns", "1.md"))).toBe("first");
    expect(yield* fs.readFileString(path.join(dir, "last-message.md"))).toBe("second");
    expect(yield* Store.readHandoff(dir, 3)).toEqual({
      handoff: { turn: 2, text: "second" },
      latestTurnWithoutHandoff: true,
    });
    expect(yield* Store.readHandoff(dir, 2)).toEqual({
      handoff: { turn: 2, text: "second" },
      latestTurnWithoutHandoff: false,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("appends raw Codex messages without dropping unfamiliar fields", () =>
  Effect.gen(function* () {
    const { fs, path, dir } = yield* setup();
    const message = { method: "new/method", params: { future: true } };
    yield* Store.appendCodexMessage(dir, message);
    yield* Store.appendCodexMessage(dir, message);
    expect(yield* fs.readFileString(path.join(dir, "codex.jsonl"))).toBe(
      `${JSON.stringify(message)}\n${JSON.stringify(message)}\n`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
