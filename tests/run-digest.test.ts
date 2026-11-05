import { readFileSync } from "node:fs";
import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { buildDigest, renderDigest } from "../src/core/runs/digest";
import {
  Digest,
  QuestionLine,
  type RunEvent,
  type RunEventBody,
  RunRecord,
} from "../src/schemas/daemon";

const run = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
  readFileSync(new URL("./fixtures/runs/run.json", import.meta.url), "utf8"),
);
const now = DateTime.toEpochMillis(run.createdAt) + 724_000;
const at = run.createdAt;
const event = (body: RunEventBody, index: number): RunEvent => ({
  seq: index + 1,
  at,
  event: body,
});
const questions = [
  Schema.decodeUnknownSync(QuestionLine)({
    _tag: "Asked",
    id: "q1",
    turn: 1,
    kind: "question",
    question: "Already answered?",
    at: "2026-11-05T19:00:00Z",
  }),
  Schema.decodeUnknownSync(QuestionLine)({
    _tag: "Resolved",
    id: "q1",
    resolution: "answered",
    text: "yes",
    at: "2026-11-05T19:00:10Z",
  }),
  Schema.decodeUnknownSync(QuestionLine)({
    _tag: "Asked",
    id: "q2",
    turn: 2,
    kind: "blocked",
    question: "lint rejects the CLI-help test's runtime imports under src/",
    at: "2026-11-05T19:10:54Z",
  }),
];

const commands = Array.from({ length: 84 }, (_, index) =>
  event(
    {
      _tag: "Command",
      command: "bun run test:unit tests/cli.test.ts",
      status: index === 81 ? "failed" : "completed",
      exitCode: index >= 82 ? 1 : 0,
      outputTail: "",
    },
    index,
  ),
);
const events = [
  ...commands,
  event({ _tag: "HookBlocked", event: "preToolUse", feedback: "denied" }, 84),
  event({ _tag: "McpStartupFailed", server: "private-server", error: "no login" }, 85),
  event({ _tag: "Retrying", message: "reconnecting silently" }, 86),
];
const tokens = {
  input: 4_100_000,
  cachedInput: 3_936_000,
  output: 31_000,
  reasoningOutput: 20_000,
};

function fullDigest(): Digest {
  return buildDigest(
    { ...run, tokens },
    events,
    questions,
    "~/.local/share/forman/runs/unit-a",
    now,
    {
      filesWritten: ["src/cli.ts", "src/commands/run.ts", "tests/cli.test.ts"],
      outsideMayChange: [],
      newInGitStatus: ["?? src/commands/run.ts"],
    },
  );
}

describe("digest data", () => {
  it("counts commands, failed status or nonzero exits and hook blocks, selecting the last command", () => {
    const digest = fullDigest();
    expect(digest.commands).toEqual({
      total: 84,
      failed: 3,
      blockedByHooks: 1,
      last: { command: "bun run test:unit tests/cli.test.ts", exitCode: 1 },
    });
    expect(digest.elapsedMs).toBe(724_000);
    expect(digest.questions).toEqual([
      {
        id: "q2",
        kind: "blocked",
        pendingMs: 70_000,
        question: "lint rejects the CLI-help test's runtime imports under src/",
      },
    ]);
    expect(digest.tokens).toEqual(tokens);
    expect(digest.failure).toBeNull();
    expect(Schema.decodeUnknownSync(Digest)(Schema.encodeSync(Digest)(digest))).toEqual(digest);
    expect(renderDigest(digest)).not.toMatch(/private-server|reconnecting silently|no login/);
  });

  it("counts a failed command once, handles a missing exit code, and ignores file-change items for counts", () => {
    const digest = buildDigest(
      run,
      [
        event(
          { _tag: "Command", command: "bad", status: "failed", exitCode: 2, outputTail: "" },
          0,
        ),
        event(
          {
            _tag: "Command",
            command: "declined",
            status: "declined",
            exitCode: null,
            outputTail: "",
          },
          1,
        ),
        event({ _tag: "FileChange", paths: ["x"] }, 2),
      ],
      [],
      "/runs/unit-a",
      now,
      null,
    );
    expect(digest.commands).toEqual({
      total: 2,
      failed: 1,
      blockedByHooks: 0,
      last: { command: "declined", exitCode: null },
    });
    expect(digest.filesWritten).toBeNull();
    expect(digest.newInGitStatus).toBeNull();
    expect(renderDigest(digest)).toContain("  last:    declined  exit=(none)");
  });

  it.each([
    "serverOverloaded",
    "rateLimitExceeded",
    "policyCapacityUnavailable",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
    "httpConnectionFailed",
  ])("classifies %s as transient, in both string and object forms", (kind) => {
    for (const codexErrorInfo of [kind, { [kind]: { detail: "capacity" } }]) {
      const digest = buildDigest(
        { ...run, state: "failed", failure: { message: "Failed", codexErrorInfo } },
        [],
        [],
        "/runs/unit-a",
        now,
        null,
      );
      expect(digest.failure).toEqual({ message: "Failed", hint: "transient" });
      expect(renderDigest(digest)).toContain(
        "failure:   Failed\ntransient: send a short followup like 'continue'",
      );
    }
  });

  it.each(["usageLimitExceeded", { usageLimitExceeded: {} }])(
    "classifies usage limits: %j",
    (codexErrorInfo) => {
      const digest = buildDigest(
        { ...run, failure: { message: "Limit", codexErrorInfo } },
        [],
        [],
        "/runs/unit-a",
        now,
        null,
      );
      expect(digest.failure).toEqual({ message: "Limit", hint: "usage-limit" });
      expect(renderDigest(digest)).toContain("usage-limit: the plan's usage limit was reached");
    },
  );

  it.each([null, "somethingNew", { somethingNew: {} }, "internalServerError", 1])(
    "keeps unknown failures without guessing a hint: %j",
    (codexErrorInfo) => {
      expect(
        buildDigest(
          { ...run, failure: { message: "Unknown", codexErrorInfo } },
          [],
          [],
          "/runs/unit-a",
          now,
          null,
        ).failure,
      ).toEqual({ message: "Unknown", hint: null });
    },
  );

  it("passes through warnings and clamps negative question ages and elapsed time", () => {
    const digest = buildDigest(
      { ...run, warnings: ["Questions may not reach Claude in this turn."] },
      [],
      questions,
      "/runs/unit-a",
      0,
      null,
    );
    expect(digest.elapsedMs).toBe(0);
    expect(digest.questions[0]?.pendingMs).toBe(0);
    expect(digest.warnings).toEqual(["Questions may not reach Claude in this turn."]);
    expect(renderDigest(digest)).toContain(
      "warning:   Questions may not reach Claude in this turn.",
    );
  });
});

describe("human digest", () => {
  it("matches the full RFC example layout", () => {
    expect(renderDigest(fullDigest())).toBe(
      [
        "run:       unit-a  running  12m04s  (gpt-6.1-sol, high, priority, write)",
        "dir:       ~/.local/share/forman/runs/unit-a",
        "worktree:  /repo/.claude/worktrees/unit-a",
        "turn:      2 (followup)",
        "question:  q2 (blocked) pending 1m10s: lint rejects the CLI-help test's runtime imports under src/",
        "commands:  84 (3 failed, 1 blocked by repo hooks)",
        "  last:    bun run test:unit tests/cli.test.ts  exit=1",
        "files written:  src/cli.ts, src/commands/run.ts, tests/cli.test.ts",
        "outside May change:  (none)",
        "new in git status since start:  ?? src/commands/run.ts",
        "tokens:    4.1M in (96% cached), 31K out",
      ].join("\n"),
    );
  });

  it("renders a minimal digest and all none cases", () => {
    const minimal = buildDigest(
      { ...run, state: "starting", sandbox: "read-only", turns: 0, turnKind: null },
      [],
      [],
      "/runs/unit-a",
      DateTime.toEpochMillis(run.createdAt),
      {
        filesWritten: [],
        newInGitStatus: [],
        outsideMayChange: null,
      },
    );
    expect(renderDigest(minimal)).toBe(
      [
        "run:       unit-a  starting  0s  (gpt-6.1-sol, high, priority, read-only)",
        "dir:       /runs/unit-a",
        "worktree:  /repo/.claude/worktrees/unit-a",
        "turn:      0",
        "question:  (none)",
        "commands:  0 (0 failed, 0 blocked by repo hooks)",
        "  last:    (none)",
        "files written:  (none)",
        "outside May change:  (no May change entry)",
        "new in git status since start:  (none)",
        "tokens:    (none)",
      ].join("\n"),
    );
  });

  it("keeps unavailable worktree fields distinct from empty lists and handles zero input tokens", () => {
    const digest = buildDigest(
      { ...run, tokens: { input: 0, cachedInput: 0, output: 12, reasoningOutput: 0 } },
      [],
      [],
      "/runs/unit-a",
      now,
      null,
    );
    expect(renderDigest(digest)).toContain("files written:  (not computed)");
    expect(renderDigest(digest)).toContain("outside May change:  (not computed)");
    expect(renderDigest(digest)).toContain("new in git status since start:  (not computed)");
    expect(renderDigest(digest)).toContain("tokens:    0 in (0% cached), 12 out");
  });
});
