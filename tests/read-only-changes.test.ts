// The changed-files check for read-only turns on a provider whose read-only mode leaves shell
// commands unsandboxed (agy): the snapshot diff rules, then real daemon runs against the fake agent.
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../src/core/process";
import type { RunRecord } from "../src/schemas/daemon";
import {
  changedSince,
  checksReadOnly,
  readSnapshot,
  snapshotOf,
  statusPath,
} from "../src/supervisor/read-only-check";
import { command, message, permission, prompt } from "./fixtures/fake-acp-agent/scenarios";
import { agyFixture, agyPlatform as platform } from "./helpers/agy";

const at = DateTime.makeUnsafe(0);
const record = (patch: Partial<RunRecord>): RunRecord => ({
  name: "unit" as RunRecord["name"],
  threadId: null,
  provider: "agy",
  group: "/repo",
  worktree: "/repo/work/unit",
  baseCommit: "abc",
  model: "gemini-4-neon",
  effort: "low",
  tier: "n/a",
  sandbox: "read-only",
  questionTimeoutMs: 900_000,
  state: "running",
  turns: 1,
  turnKind: "start",
  activeTurnId: null,
  turnBudgetMs: null,
  turnStartedAt: null,
  restoreSandbox: false,
  tokens: null,
  failure: null,
  warnings: [],
  createdAt: at,
  updatedAt: at,
  ...patch,
});

/** A read-only record with no provider field, as runs written before providers have. */
function legacyRecord(): RunRecord {
  const { provider: _, ...rest } = record({});
  return rest;
}

describe("which turns are checked", () => {
  it.each<[string, RunRecord, "start" | "followup" | "handoff", boolean]>([
    ["a read-only agy turn", record({}), "start", true],
    ["a read-only agy follow-up", record({}), "followup", true],
    ["a write agy turn", record({ sandbox: "danger-full-access" }), "start", false],
    ["a write agy run's hand-off turn", record({ sandbox: "danger-full-access" }), "handoff", true],
    [
      "a read-only Codex turn, which Codex sandboxes",
      record({ provider: "codex" }),
      "start",
      false,
    ],
    ["a run written before providers (Codex)", legacyRecord(), "handoff", false],
  ])("%s", (_, run, kind, expected) => {
    expect(checksReadOnly(run, kind)).toBe(expected);
  });
});

describe("the snapshot diff", () => {
  const snap = (entries: [string, string | null][]) =>
    snapshotOf(
      entries.map(([line]) => line),
      new Map(
        entries.flatMap(([line, hash]): [string, string][] =>
          hash === null ? [] : [[statusPath(line), hash]],
        ),
      ),
    );
  it.each<[string, [string, string | null][], [string, string | null][], string[]]>([
    ["a new file in a read-only turn", [], [["?? leak.txt", "h1"]], ["leak.txt"]],
    [
      "a new file in a hand-off after the write turn's work",
      [["?? work.txt", "h1"]],
      [
        ["?? leak.txt", "h2"],
        ["?? work.txt", "h1"],
      ],
      ["leak.txt"],
    ],
    ["a hand-off that changed nothing", [["?? work.txt", "h1"]], [["?? work.txt", "h1"]], []],
    [
      "a rewrite of a file that was already modified",
      [[" M src/a.ts", "h1"]],
      [[" M src/a.ts", "h2"]],
      ["src/a.ts"],
    ],
    ["a rename, by its destination", [], [["R  old.ts -> new.ts", "h1"]], ["new.ts"]],
    ["a quoted rename with spaces", [], [['R  "old a.ts" -> "new b.ts"', "h1"]], ["new b.ts"]],
    ["a quoted non-ASCII name", [], [['?? "caf\\303\\251.txt"', "h1"]], ["café.txt"]],
    ["a modification reverted", [[" M src/a.ts", "h1"]], [], ["src/a.ts"]],
    ["a file deleted", [], [[" D gone.ts", null]], ["gone.ts"]],
  ])("%s", (_, before, after, expected) => {
    expect(changedSince(snap(before), snap(after))).toEqual(expected);
  });
});

it.live(
  "snapshots of a real worktree catch a new file, a rewrite and a deletion",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-ro-" });
      const git = Effect.fnUntraced(function* (...args: string[]) {
        const result = yield* commandResult(ChildProcess.make("git", args, { cwd: repo }));
        if (result.code !== 0) return yield* Effect.die(`git failed: ${result.stderr}`);
      });
      yield* fs.writeFileString(`${repo}/kept.txt`, "one\n");
      yield* fs.writeFileString(`${repo}/gone.txt`, "bye\n");
      yield* git("init", "-q");
      yield* git("add", ".");
      yield* git(
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "base",
      );
      yield* fs.writeFileString(`${repo}/kept.txt`, "two\n");
      const before = yield* readSnapshot(repo);
      yield* fs.writeFileString(`${repo}/kept.txt`, "three\n");
      yield* fs.writeFileString(`${repo}/new file.txt`, "new\n");
      yield* fs.remove(`${repo}/gone.txt`);
      expect(changedSince(before, yield* readSnapshot(repo))).toEqual([
        "gone.txt",
        "kept.txt",
        "new file.txt",
      ]);
      expect(changedSince(before, before)).toEqual([]);
    }).pipe(Effect.provide(platform), Effect.scoped),
  30_000,
);

const leak = "read-only agy run changed files: leak.txt";

it.live(
  "a read-only agy run whose shell command writes a file fails with the changed path",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture({
        rules: [
          prompt([
            ...permission("cmd", "execute", "touch leak.txt", "run_command"),
            ...command("touch leak.txt", ""),
            { writeFile: "{{cwd}}/leak.txt", text: "leaked\n" },
            message("Done."),
          ]),
          prompt([message("Nothing else.")], "end_turn", true),
        ],
      });
      yield* f.start(false);
      const digest = yield* f.until("failed");
      expect(digest.failure?.message).toBe(leak);
      expect(digest.warnings.filter((warning) => warning === leak)).toHaveLength(1);
      // A follow-up that changes nothing new isn't failed for the earlier change.
      yield* f.request({ _tag: "Followup", name: f.name, message: "Anything else?" });
      const followup = yield* f.until("idle", 2);
      expect(followup.failure).toBeNull();
      expect(followup.warnings.filter((warning) => warning === leak)).toHaveLength(1);
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a write run's hand-off that writes a file fails, even when status refreshes mid-turn",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* agyFixture({
        rules: [
          prompt(
            [{ writeFile: "{{cwd}}/work.txt", text: "work\n" }, { awaitRequest: "session/cancel" }],
            "cancelled",
          ),
          prompt([
            { writeFile: "{{cwd}}/leak.txt", text: "leaked\n" },
            { sleepMs: 1500 },
            message("Handing off."),
          ]),
        ],
      });
      yield* f.request({
        _tag: "Start",
        name: f.name,
        worktree: f.worktree,
        contract: "Create work.txt.",
        write: true,
        provider: "agy",
        model: "gemini-4-neon",
        effort: "low",
        budgetMs: 300,
        skipDepsCheck: false,
      });
      while (!(yield* fs.exists(`${f.worktree}/leak.txt`))) yield* Effect.sleep("10 millis");
      // Status refreshes the run's cached worktree fields while the hand-off is still running.
      const during = yield* f.request({ _tag: "Status", name: f.name, cwd: f.repo });
      expect(during).toMatchObject({ digests: [{ turn: 2, turnKind: "handoff" }] });
      const digest = yield* f.until("failed");
      expect(digest.failure?.message).toBe(leak);
    }).pipe(Effect.provide(platform)),
  30_000,
);
