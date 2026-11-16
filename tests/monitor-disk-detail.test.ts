import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Schema } from "effect";
import { CONTRACT_BYTE_LIMIT, diskDetail } from "../src/core/runs/disk-detail";
import * as Store from "../src/core/runs/store";
import { DaemonResult, QuestionId, RunName, type RunRecord } from "../src/schemas/daemon";

const at = DateTime.makeUnsafe("2026-11-16T12:00:00Z");
const later = DateTime.makeUnsafe("2026-11-16T12:01:00Z");
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const name = Schema.decodeUnknownSync(RunName)("saved");
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
  turns: 3,
  turnKind: "start",
  activeTurnId: null,
  turnBudgetMs: null,
  turnStartedAt: at,
  restoreSandbox: false,
  tokens: null,
  failure: null,
  warnings: [],
  createdAt: at,
  updatedAt: later,
};
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-detail-" });
  const dir = `${home}/runs/${name}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* Store.writeRun(dir, record);
  return { fs, home, dir };
});

it.effect(
  "folds pending, deferred, answered, auto-answered, cancelled, superseded, late and corrected questions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const expected = [];
      for (const [index, resolution] of [
        "pending",
        "deferred",
        "answered",
        "auto-answered",
        "cancelled",
        "superseded",
        "late",
        "correction",
      ].entries()) {
        const id = Schema.decodeUnknownSync(QuestionId)(`q${index + 1}`);
        yield* Store.appendQuestion(f.dir, {
          _tag: "Asked",
          id,
          turn: 1,
          kind: "blocked",
          question: resolution,
          at,
        });
        let status: "pending" | "deferred" | "resolved" | "cancelled" = "resolved";
        if (resolution === "pending") status = "pending";
        else if (resolution === "deferred") {
          status = "deferred";
          yield* Store.appendQuestion(f.dir, {
            _tag: "Deferred",
            id,
            at: later,
            by: "orchestrator",
          });
        } else {
          if (resolution === "cancelled" || resolution === "superseded") status = "cancelled";
          if (resolution === "late" || resolution === "correction")
            yield* Store.appendQuestion(f.dir, { _tag: "Deferred", id, at, by: "timeout" });
          yield* Store.appendQuestion(f.dir, {
            _tag: "Resolved",
            id,
            at: later,
            resolution: Schema.decodeUnknownSync(
              Schema.Literals([
                "answered",
                "auto-answered",
                "cancelled",
                "superseded",
                "late",
                "correction",
              ]),
            )(resolution),
            text: status === "cancelled" ? null : "yes",
          });
        }
        expected.push({
          id,
          kind: "blocked" as const,
          text: resolution,
          askedAt: at,
          status,
          resolvedAt: status === "pending" || status === "deferred" ? null : later,
        });
      }
      const detail = yield* diskDetail(f.home, name);
      assert.isNotNull(detail);
      assert.deepStrictEqual(detail?.questions, expected);
      assert.isTrue(Schema.is(DaemonResult)(detail));
    }).pipe(Effect.provide(platform)),
);

it.effect.each([
  { text: "", expected: "", truncated: false },
  {
    text: "a".repeat(CONTRACT_BYTE_LIMIT),
    expected: "a".repeat(CONTRACT_BYTE_LIMIT),
    truncated: false,
  },
  {
    text: `${"a".repeat(CONTRACT_BYTE_LIMIT - 1)}éend`,
    expected: "a".repeat(CONTRACT_BYTE_LIMIT - 1),
    truncated: true,
  },
])(
  "reads contract bytes with UTF-8-safe truncation ($truncated)",
  ({ text, expected, truncated }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.writeFileString(`${f.dir}/contract.md`, text);
      const detail = yield* diskDetail(f.home, name);
      assert.strictEqual(detail?.contract, expected);
      assert.strictEqual(detail?.contractTruncated, truncated);
      assert.strictEqual(detail?.contractByteLimit, CONTRACT_BYTE_LIMIT);
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "reads the latest available hand-off and recorded digest without spawning or modifying files",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Store.writeHandoff(f.dir, 1, "old");
      yield* Store.writeHandoff(f.dir, 2, "latest");
      yield* Store.appendEvent(f.dir, {
        _tag: "Command",
        command: "false",
        status: "failed",
        exitCode: 1,
        outputTail: "failed",
      });
      const before = yield* f.fs.readFileString(`${f.dir}/run.json`);
      const detail = yield* diskDetail(f.home, name);
      assert.deepStrictEqual(detail?.handoff, { turn: 2, text: "latest" });
      assert.deepStrictEqual(detail?.digest.commands, {
        total: 1,
        failed: 1,
        blockedByHooks: 0,
        last: { command: "false", exitCode: 1 },
      });
      assert.strictEqual(detail?.digest.filesWritten, null);
      assert.strictEqual(detail?.contract, "");
      assert.deepStrictEqual(detail?.record, {
        runDir: f.dir,
        worktree: record.worktree,
        branch: null,
        baseCommit: "abc",
        fromRef: null,
        createdAt: at,
        updatedAt: later,
      });
      assert.deepStrictEqual(yield* diskDetail(f.home, name), detail);
      assert.strictEqual(yield* f.fs.readFileString(`${f.dir}/run.json`), before);
      assert.deepStrictEqual((yield* f.fs.readDirectory(f.home)).sort(), ["runs"]);
      // Only filesystem and path services are supplied: spawning would fail this read.
    }).pipe(Effect.provide(platform)),
);

it.effect("returns null for a missing run without creating its home", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const home = `${f.home}/absent`;
    assert.strictEqual(yield* diskDetail(home, name), null);
    assert.isFalse(yield* f.fs.exists(home));
  }).pipe(Effect.provide(platform)),
);
