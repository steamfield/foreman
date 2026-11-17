import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Logger, References, Schema } from "effect";
import { TestClock } from "effect/testing";
import { diskOverview } from "../src/core/runs/disk-overview";
import { readHistory } from "../src/core/runs/history";
import * as Store from "../src/core/runs/store";
import { RunName, RunRecord } from "../src/schemas/daemon";

const at = DateTime.makeUnsafe("2026-11-16T12:00:00Z");
const record = (name: string, state: RunRecord["state"]): RunRecord => ({
  name: Schema.decodeUnknownSync(RunName)(name),
  threadId: null,
  group: "/repos/example",
  worktree: "/repos/example/work/unit",
  baseCommit: "abc",
  model: "gpt-6.1-sol",
  effort: "high",
  tier: "fast",
  sandbox: "danger-full-access",
  questionTimeoutMs: 60_000,
  state,
  turns: 3,
  turnKind: "start",
  activeTurnId: null,
  turnBudgetMs: 30_000,
  turnStartedAt: at,
  restoreSandbox: false,
  tokens: { input: 10, output: 5, cachedInput: 2, reasoningOutput: 1 },
  failure: null,
  warnings: [],
  createdAt: at,
  updatedAt: at,
});

const save = Effect.fnUntraced(function* (home: string, saved: RunRecord, archived = false) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${home}/runs/${saved.name}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* Store.writeRun(dir, saved);
  return archived ? yield* Store.archiveRun(home, saved.name) : dir;
});

const withLogs = Effect.fnUntraced(function* (home: string, limit: number) {
  const logs: {
    level: string;
    message: unknown;
    annotations: Readonly<Record<string, unknown>>;
  }[] = [];
  const logger = Logger.make((input) => {
    logs.push({
      level: input.logLevel,
      message: input.message,
      annotations: input.fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  const entries = yield* readHistory(home, limit).pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  );
  return { entries, logs };
});

it.effect("merges archived and inactive current runs newest-ended first", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const expected = [];
    for (const [name, state, archived, time] of [
      ["old", "idle", true, 1000],
      ["current", "idle", false, 2000],
      ["new", "failed", true, 3000],
    ] as const) {
      const saved = { ...record(name, state), updatedAt: DateTime.makeUnsafe(time) };
      const dir = yield* save(home, saved, archived);
      expected.push({
        name: saved.name,
        repo: "example",
        title: null,
        state,
        archived,
        model: saved.model,
        effort: saved.effort,
        createdAt: at,
        endedAt: saved.updatedAt,
        turns: 3,
        tokensTotal: 15,
        commands: { total: 0, failed: 0 },
        filesWritten: 0,
        dir,
      });
    }
    for (const state of ["starting", "running", "waiting"] as const)
      yield* save(home, record(state, state));
    assert.deepStrictEqual(yield* readHistory(home, 10), expected.toReversed());
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses the last StateChanged time, falling back to updatedAt without state events", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const saved = { ...record("unit", "idle"), updatedAt: DateTime.makeUnsafe(9000) };
    const dir = yield* save(home, saved);
    yield* TestClock.setTime(2000);
    yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "idle", to: "running" });
    yield* TestClock.setTime(3000);
    yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "running", to: "idle" });
    yield* TestClock.setTime(8000);
    yield* Store.appendEvent(dir, { _tag: "Other", method: "later activity" });
    assert.deepStrictEqual((yield* readHistory(home, 10))[0]?.endedAt, DateTime.makeUnsafe(3000));
    yield* fs.writeFileString(`${dir}/events.jsonl`, "");
    assert.deepStrictEqual((yield* readHistory(home, 10))[0]?.endedAt, saved.updatedAt);
    yield* Store.appendEvent(dir, { _tag: "Other", method: "no transition" });
    assert.deepStrictEqual((yield* readHistory(home, 10))[0]?.endedAt, saved.updatedAt);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("matches saved overview titles, completed commands and distinct written files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const dir = yield* save(home, record("unit", "idle"));
    yield* fs.writeFileString(
      `${dir}/contract.md`,
      "Preamble\n\n## Task title ##\n# Later heading",
    );
    for (const exitCode of [0, 1, 0, null])
      yield* Store.appendEvent(dir, {
        _tag: "Command",
        command: "check",
        status: "completed",
        exitCode,
        outputTail: "",
      });
    for (const paths of [["a.ts"], ["a.ts", "b.ts"]])
      yield* Store.appendEvent(dir, { _tag: "FileChange", paths });
    const overview = (yield* diskOverview(home)).runs[0];
    const history = (yield* readHistory(home, 10))[0];
    assert.isDefined(overview);
    assert.isDefined(history);
    assert.strictEqual(history.title, "Task title");
    assert.strictEqual(history.title, overview.title);
    assert.deepStrictEqual(history.commands, { total: 3, failed: 1 });
    assert.deepStrictEqual(history.commands, overview.commands);
    assert.strictEqual(history.filesWritten, 2);
    assert.strictEqual(history.filesWritten, overview.filesWritten);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("limits journal reads to the two newest record mtimes before sorting by endedAt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    for (const [name, mtime, ended] of [
      ["first", 4000, 1000],
      ["second", 3000, 2000],
      ["corrupt", 2000, 9000],
      ["outside", 1000, 8000],
    ] as const) {
      const dir = yield* save(home, record(name, "idle"), true);
      yield* TestClock.setTime(ended);
      yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "running", to: "idle" });
      if (name === "corrupt") yield* fs.writeFileString(`${dir}/events.jsonl`, "broken\n");
      yield* fs.utimes(`${dir}/run.json`, new Date(mtime), new Date(mtime));
    }
    const result = yield* withLogs(home, 2);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.name),
      ["second", "first"],
    );
    assert.deepStrictEqual(result.logs, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["run.json", "events.jsonl"] as const)(
  "skips corrupt %s and logs the directory and original error tag once at debug",
  (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* save(home, record("good", "idle"));
      const bad = yield* save(home, record("bad", "failed"), true);
      yield* fs.writeFileString(`${bad}/${file}`, "broken\n");
      const { entries, logs } = yield* withLogs(home, 10);
      assert.deepStrictEqual(
        entries.map((entry) => entry.name),
        ["good"],
      );
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]?.level, "Debug");
      assert.strictEqual(logs[0]?.annotations.path, bad);
      assert.strictEqual(logs[0]?.annotations.errorTag, "SchemaError");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["runs", "archive"] as const)("returns [] with missing %s", (missing) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    if (missing === "archive") yield* fs.makeDirectory(`${home}/runs`);
    assert.deepStrictEqual(yield* withLogs(home, 10), { entries: [], logs: [] });
    assert.isFalse(yield* fs.exists(`${home}/runs/.archive`));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("logs decode failures without copying stored content into the log message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const dir = yield* save(home, record("bad", "idle"));
    yield* fs.writeFileString(`${dir}/run.json`, "private contract text\n");
    const { entries, logs } = yield* withLogs(home, 10);
    assert.deepStrictEqual(entries, []);
    assert.deepStrictEqual(
      logs.map((log) => log.message),
      [["history.skip"]],
    );
    assert.deepStrictEqual(logs[0]?.annotations, { path: dir, errorTag: "SchemaError" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("includes every specified inactive outcome and orders equal end times by name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    for (const state of ["unknown", "lost", "interrupted", "failed", "idle"] as const)
      yield* save(home, { ...record(state, state), tokens: null });
    assert.deepStrictEqual(
      (yield* readHistory(home, 10)).map(({ name, state, tokensTotal }) => ({
        name,
        state,
        tokensTotal,
      })),
      ["failed", "idle", "interrupted", "lost", "unknown"].map((state) => ({
        name: state,
        state,
        tokensTotal: 0,
      })),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("skips staging directories and non-directory entries in either source", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* save(home, record("good", "idle"));
    for (const root of [`${home}/runs`, `${home}/runs/.archive`]) {
      yield* fs.makeDirectory(`${root}/.tmp-staging`, { recursive: true });
      yield* fs.writeFileString(`${root}/.tmp-staging/run.json`, "broken");
      yield* fs.writeFileString(`${root}/ordinary-file`, "ignore");
    }
    const { entries, logs } = yield* withLogs(home, 10);
    assert.deepStrictEqual(
      entries.map((entry) => entry.name),
      ["good"],
    );
    assert.deepStrictEqual(logs, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers from journal and archive I/O failures without hiding healthy runs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* save(home, record("good", "idle"));
    const bad = yield* save(home, record("bad", "idle"));
    yield* fs.makeDirectory(`${bad}/events.jsonl`);
    yield* fs.writeFileString(`${home}/runs/.archive`, "not a directory");
    const { entries, logs } = yield* withLogs(home, 10);
    assert.deepStrictEqual(
      entries.map((entry) => entry.name),
      ["good"],
    );
    assert.strictEqual(logs.length, 2);
    assert.deepStrictEqual(logs.map((log) => log.annotations.path).sort(), [
      `${home}/runs/.archive`,
      bad,
    ]);
    assert.isTrue(
      logs.every((log) => log.level === "Debug" && log.annotations.errorTag === "PlatformError"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves store tolerance for legacy records and uncommitted journal tails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const dir = yield* save(home, record("unit", "idle"));
    yield* fs.writeFileString(
      `${dir}/run.json`,
      JSON.stringify(Schema.encodeSync(RunRecord)(record("unit", "idle"))),
    );
    yield* Store.appendEvent(dir, { _tag: "StateChanged", from: "running", to: "idle" });
    yield* fs.writeFileString(`${dir}/events.jsonl`, "torn", { flag: "a" });
    assert.deepStrictEqual(
      (yield* readHistory(home, 10)).map((entry) => entry.name),
      ["unit"],
    );
    assert.isTrue((yield* fs.readFileString(`${dir}/events.jsonl`)).endsWith("torn"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
