import { DateTime, Schema } from "effect";
import type { DetailFeed } from "../../src/core/monitor/detail-feed";
import type { MonitorFeed } from "../../src/core/monitor/feed";
import { initialState, reduce, type State } from "../../src/core/monitor/model";
import { QuestionId, type RunEvent } from "../../src/schemas/daemon";
import type { Detail } from "../../src/schemas/monitor";
import { type Overview, RunView } from "../../src/schemas/monitor";

export const now = Date.parse("2026-11-16T12:00:00Z");
export const at = (offset = 0) => DateTime.makeUnsafe(now + offset);
export const defaults = {
  model: "gpt-6.1-sol",
  effort: "high",
  tier: "priority",
  sandbox: "danger-full-access",
} as const;
export function run(name = "fix-hooks", overrides: Partial<RunView> = {}): RunView {
  return {
    ...Schema.decodeUnknownSync(RunView)({
      name,
      group: "/repo",
      repo: "/repo",
      worktree: "/repo/work",
      branch: "work",
      title: "Fix hooks",
      ...defaults,
      state: "running",
      stateSince: "2026-11-16T11:48:00Z",
      turn: 2,
      turnKind: "followup",
      turnStartedAt: "2026-11-16T11:48:00Z",
      turnBudgetMs: 3600000,
      tokensTotal: 1000,
      activity: { kind: "command", text: "bun run check", since: "2026-11-16T11:59:40Z" },
      questions: [],
      unansweredCount: 0,
      failure: null,
      retrying: null,
      hooksBlocked: 0,
      outsideMayChange: 0,
      quiet: false,
      lastActivityAt: "2026-11-16T11:59:40Z",
      subagents: [],
      warnings: [],
      commands: null,
      filesWritten: null,
      pace: [],
      reviewedAt: null,
    }),
    ...overrides,
  };
}
export function overview(runs: readonly RunView[] = [run()]): Overview {
  return {
    _tag: "Overview",
    version: 1,
    daemon: { version: "0.1.3", build: "test", startedAt: at(-8040000) },
    runs,
  };
}
export const live = (runs: readonly RunView[] = [run()]): MonitorFeed => ({
  _tag: "Live",
  overview: overview(runs),
  receivedAt: now,
});
export const question = {
  id: Schema.decodeUnknownSync(RunView.fields.questions)([
    {
      id: "q2",
      kind: "question",
      text: "Keep the existing hook API?",
      askedAt: "2026-11-16T11:57:00Z",
      defersAt: "2026-11-16T12:12:00Z",
    },
  ])[0],
};
export function mixedRuns() {
  return [
    run("fix-hooks", {
      state: "waiting",
      questions: question.id ? [question.id] : [],
      subagents: [
        {
          threadId: "child",
          path: "/root/acceptance_tests",
          model: "gpt-6-sol",
          effort: "medium",
          state: "working",
          startedAt: at(-60000),
          lastInteractionAt: at(-20000),
          interactions: 2,
        },
        {
          threadId: "idle",
          path: "/root/review",
          model: null,
          effort: null,
          state: "idle",
          startedAt: at(-180000),
          lastInteractionAt: at(-120000),
          interactions: 1,
        },
      ],
    }),
    run("parser", {
      quiet: true,
      activity: { kind: "message", text: "Checking the parser boundaries", since: at(-360000) },
      lastActivityAt: at(-360000),
      hooksBlocked: 3,
      outsideMayChange: 2,
      unansweredCount: 2,
      retrying: { at: at(), message: "usage limit" },
      effort: "medium",
      sandbox: "read-only",
    }),
    run("finished", {
      state: "idle",
      activity: { kind: "outcome", text: "All checks passed.\nMore details", since: at(-60000) },
    }),
    run("older", { state: "idle", stateSince: at(-90000000) }),
    run("other", {
      group: "/other",
      repo: "/other",
      state: "waiting",
      questions: question.id ? [question.id] : [],
    }),
  ];
}
export const subagents = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    threadId: `child-${index}`,
    path: `/root/child-${String(index).padStart(2, "0")}`,
    model: null,
    effort: null,
    state: "idle" as const,
    startedAt: at(-60000),
    lastInteractionAt: at(-20000),
    interactions: 1,
  }));

export function detail(runView = mixedRuns()[0] ?? run()): Detail {
  return {
    _tag: "Detail",
    version: 1,
    run: runView,
    record: {
      runDir: `/data/runs/${runView.name}`,
      worktree: runView.worktree,
      branch: runView.branch,
      baseCommit: "abc123",
      fromRef: "main",
      createdAt: at(-3600000),
      updatedAt: at(),
    },
    contract:
      "# Fix hook handling\nKeep the existing hook API.\nUse real dependencies.\n\nMay change: src/hooks.ts\nMust not change: src/daemon/",
    contractTruncated: false,
    contractByteLimit: 65536,
    questions: ["pending", "deferred", "resolved", "cancelled"].map((status, index) => ({
      id: Schema.decodeUnknownSync(RunView.fields.questions.value.fields.id)(`q${index + 1}`),
      kind: "question",
      text: `Question ${index + 1}: keep the API?`,
      askedAt: at(-180000),
      status: Schema.decodeUnknownSync(
        Schema.Literals(["pending", "deferred", "resolved", "cancelled"]),
      )(status),
      resolvedAt: index < 2 ? null : at(-60000),
    })),
    handoff: { turn: 1, text: "Updated the hooks.\nChecks passed." },
    digest: {
      name: runView.name,
      state: runView.state,
      elapsedMs: 720000,
      model: runView.model,
      effort: runView.effort,
      tier: runView.tier,
      sandbox: runView.sandbox,
      runDir: `/data/runs/${runView.name}`,
      worktree: runView.worktree,
      turn: runView.turn,
      turnKind: runView.turnKind,
      questions: [],
      commands: {
        total: 12,
        failed: 1,
        blockedByHooks: 2,
        last: { command: "bun run check", exitCode: 0 },
      },
      filesWritten: ["src/hooks.ts"],
      outsideMayChange: [],
      newInGitStatus: null,
      tokens: { input: 1000, cachedInput: 750, output: 200, reasoningOutput: 100 },
      failure: null,
      warnings: [],
    },
  };
}
export const messageEvents = (count: number, start = 1): RunEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    seq: start + index,
    at: at(),
    event: { _tag: "AgentMessage", text: `event ${start + index}`, phase: "commentary" },
  }));
export const detailLive = (data = detail(), events = messageEvents(40)): DetailFeed => ({
  _tag: "Live",
  detail: data,
  events,
  gap: false,
  receivedAt: now,
});
export function detailEvents(): RunEvent[] {
  const sample = detail();
  return [
    ...messageEvents(1),
    {
      seq: 2,
      at: sample.record.updatedAt,
      event: {
        _tag: "Command" as const,
        command: "bun run check",
        status: "inProgress",
        exitCode: null,
        outputTail: "",
      },
    },
    {
      seq: 3,
      at: sample.record.updatedAt,
      event: {
        _tag: "Command" as const,
        command: "bun run lint",
        status: "completed",
        exitCode: 0,
        outputTail: "",
      },
    },
    {
      seq: 4,
      at: sample.record.updatedAt,
      event: {
        _tag: "Command" as const,
        command: "bun run test",
        status: "failed",
        exitCode: 2,
        outputTail: "",
      },
    },
    {
      seq: 5,
      at: sample.record.updatedAt,
      event: { _tag: "FileChange" as const, paths: ["src/hooks.ts"] },
    },
    {
      seq: 6,
      at: sample.record.updatedAt,
      event: {
        _tag: "QuestionAsked",
        id: Schema.decodeUnknownSync(QuestionId)("q1"),
        kind: "question",
        question: "Keep the API?",
      },
    },
    {
      seq: 7,
      at: sample.record.updatedAt,
      event: { _tag: "HookBlocked" as const, event: "pre-commit", feedback: "Fix lint first." },
    },
    {
      seq: 8,
      at: sample.record.updatedAt,
      event: { _tag: "StateChanged" as const, from: "running" as const, to: "waiting" as const },
    },
    {
      seq: 9,
      at: sample.record.updatedAt,
      event: { _tag: "TurnStarted" as const, turn: 2, kind: "followup" as const },
    },
    {
      seq: 10,
      at: sample.record.updatedAt,
      event: {
        _tag: "QuestionResolved",
        id: Schema.decodeUnknownSync(QuestionId)("q2"),
        resolution: "deferred",
      },
    },
  ];
}

/** Sends a terminal key through the monitor's public reducer. */
export const monitorKey = (state: State, key: string): State => reduce(state, { type: "key", key });

/** Opens a live detail with the supplied run and event journal. */
export function inspectStart(data = detail(), events = detailEvents()): State {
  return reduce(
    initialState({
      group: "/repo",
      defaults,
      version: "dev",
      now,
      columns: 100,
      rows: 40,
      name: data.run.name,
    }),
    {
      type: "detail-feed",
      name: data.run.name,
      value: detailLive(data, events),
    },
  );
}

/** Moves focus through the detail's visible panes. */
export function focusFiles(state: State): State {
  for (let i = 0; i < 10 && state.detail?.focus !== "files"; i++) state = monitorKey(state, "tab");
  return state;
}
