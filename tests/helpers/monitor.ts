import { DateTime, Schema } from "effect";
import type { MonitorFeed } from "../../src/core/monitor/feed";
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
