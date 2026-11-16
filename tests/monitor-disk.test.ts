import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { diskOverview } from "../src/core/runs/disk-overview";
import * as Store from "../src/core/runs/store";
import { QuestionId, RunName, type RunRecord } from "../src/schemas/daemon";

const at = DateTime.makeUnsafe("2026-11-16T12:00:00Z");
const record = (name: string, state: RunRecord["state"]): RunRecord => ({
  name: Schema.decodeUnknownSync(RunName)(name),
  threadId: null,
  group: "/repo",
  worktree: "/repo/work/unit",
  baseCommit: "abc",
  model: "gpt-6.1-sol",
  effort: "high",
  tier: "fast",
  sandbox: "danger-full-access",
  questionTimeoutMs: 60_000,
  state,
  turns: 1,
  turnKind: "start",
  activeTurnId: null,
  turnBudgetMs: 30_000,
  turnStartedAt: at,
  restoreSandbox: false,
  tokens: { input: 10, output: 5, cachedInput: 0, reasoningOutput: 0 },
  failure:
    state === "failed"
      ? { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" }
      : null,
  warnings: [],
  createdAt: at,
  updatedAt: at,
});

const listing = Effect.fnUntraced(function* (
  root: string,
): Effect.fn.Return<
  readonly unknown[],
  import("effect").PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const entries: unknown[] = [];
  for (const name of (yield* fs.readDirectory(root)).sort()) {
    const path = `${root}/${name}`;
    const info = yield* fs.stat(path);
    entries.push([name, info.type, info.size.toString(), info.mtime]);
    if (info.type === "Directory") entries.push([name, yield* listing(path)]);
  }
  return entries;
});

it.effect(
  "reads saved runs, questions, titles and failure hints without changing any home file",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-disk-" });
      for (const state of ["idle", "failed", "waiting", "running"] as const) {
        const dir = `${home}/runs/${state}`;
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* Store.writeRun(dir, record(state, state));
        yield* fs.writeFileString(`${dir}/contract.md`, "# Saved task\n\nDo this.");
        yield* fs.writeFileString(`${dir}/last-message.md`, "Finished the work.\nMore detail.");
      }
      const q1 = Schema.decodeUnknownSync(QuestionId)("q1");
      const q2 = Schema.decodeUnknownSync(QuestionId)("q2");
      const q3 = Schema.decodeUnknownSync(QuestionId)("q3");
      const dir = `${home}/runs/waiting`;
      for (const id of [q1, q2, q3])
        yield* Store.appendQuestion(dir, {
          _tag: "Asked",
          id,
          turn: 1,
          kind: "blocked",
          question: `Help ${id}?`,
          at,
        });
      yield* Store.appendQuestion(dir, { _tag: "Deferred", id: q2, at, by: "orchestrator" });
      yield* Store.appendQuestion(dir, {
        _tag: "Resolved",
        id: q3,
        at,
        resolution: "answered",
        text: "yes",
      });
      yield* fs.makeDirectory(`${home}/runs/corrupt`);
      yield* fs.writeFileString(`${home}/runs/corrupt/run.json`, "broken");
      yield* fs.makeDirectory(`${home}/runs/bad-questions`);
      yield* Store.writeRun(`${home}/runs/bad-questions`, record("bad-questions", "waiting"));
      yield* fs.writeFileString(`${home}/runs/bad-questions/questions.jsonl`, "broken\n");
      const before = yield* listing(home);
      const view = yield* diskOverview(home);
      assert.deepStrictEqual(yield* listing(home), before);
      assert.deepStrictEqual(
        view.runs.map((run) => run.name),
        ["failed", "idle", "running", "waiting"],
      );
      assert.strictEqual(view.daemon, null);
      assert.strictEqual(view._tag, "Overview");
      for (const run of view.runs) {
        assert.strictEqual(run.title, "Saved task");
        assert.deepStrictEqual(run.stateSince, at);
        assert.deepStrictEqual(
          {
            subagents: run.subagents,
            quiet: run.quiet,
            lastActivityAt: run.lastActivityAt,
            retrying: run.retrying,
            hooksBlocked: run.hooksBlocked,
            outsideMayChange: run.outsideMayChange,
          },
          {
            subagents: [],
            quiet: false,
            lastActivityAt: null,
            retrying: null,
            hooksBlocked: 0,
            outsideMayChange: null,
          },
        );
        assert.strictEqual(run.tokensTotal, 15);
      }
      assert.deepStrictEqual(view.runs[0]?.failure, {
        message: "Usage limit reached",
        hint: "usage-limit",
      });
      assert.deepStrictEqual(view.runs[0]?.activity, {
        kind: "failure",
        text: "Usage limit reached",
        since: at,
      });
      assert.deepStrictEqual(view.runs[1]?.activity, {
        kind: "outcome",
        text: "Finished the work.",
        since: at,
      });
      assert.strictEqual(view.runs[2]?.state, "running");
      assert.strictEqual(view.runs[2]?.activity, null);
      assert.strictEqual(view.runs[3]?.state, "waiting");
      assert.deepStrictEqual(view.runs[3]?.questions, [
        {
          id: q1,
          kind: "blocked",
          text: "Help q1?",
          askedAt: at,
          defersAt: DateTime.makeUnsafe(DateTime.toEpochMillis(at) + 60_000),
        },
      ]);
      assert.strictEqual(view.runs[3]?.unansweredCount, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("disk state ages use the last state event, falling back to creation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const dir = `${home}/runs/unit`;
    yield* fs.makeDirectory(dir, { recursive: true });
    const saved = {
      ...record("unit", "running"),
      createdAt: DateTime.makeUnsafe(1000),
      updatedAt: DateTime.makeUnsafe(9000),
    };
    yield* Store.writeRun(dir, saved);
    yield* TestClock.setTime(2000);
    yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "idle", to: "starting" });
    yield* TestClock.setTime(3000);
    yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "starting", to: "running" });
    yield* TestClock.setTime(9000);
    assert.isNotNull(saved.tokens);
    yield* Store.appendEvent(dir, { _tag: "TokenUsage", totals: saved.tokens });
    assert.deepStrictEqual(
      (yield* diskOverview(home)).runs[0]?.stateSince,
      DateTime.makeUnsafe(3000),
    );
    yield* fs.writeFileString(`${dir}/events.jsonl`, "");
    assert.deepStrictEqual((yield* diskOverview(home)).runs[0]?.stateSince, saved.createdAt);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an absent home stays absent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-disk-" });
    const home = `${root}/absent`;
    assert.deepStrictEqual(yield* diskOverview(home), { _tag: "Overview", daemon: null, runs: [] });
    assert.isFalse(yield* fs.exists(home));
  }).pipe(Effect.provide(NodeServices.layer)),
);
