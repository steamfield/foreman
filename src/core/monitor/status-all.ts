import { DateTime } from "effect";
import { activeStates } from "../../schemas/daemon";
import type { Overview, RunView } from "../../schemas/monitor";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const age = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
};
const elapsed = (at: DateTime.Utc, now: number) => age(now - DateTime.toEpochMillis(at));

function runLines(run: RunView, own: boolean, executable: string, now: number) {
  const flags = [
    ...run.questions.map(
      (question) =>
        `${question.id} (${question.kind}) pending ${elapsed(question.askedAt, now)}${question.defersAt === null ? "" : `, auto-defer in ${age(DateTime.toEpochMillis(question.defersAt) - now)}`}: ${oneLine(question.text)}`,
    ),
    ...(run.unansweredCount > 0 ? [`${run.unansweredCount} deferred, unanswered`] : []),
    ...(run.failure === null
      ? []
      : [
          `failure${run.failure.hint === null ? "" : ` (${run.failure.hint})`}: ${oneLine(run.failure.message)}`,
        ]),
    ...(run.retrying === null ? [] : [`retrying: ${oneLine(run.retrying.message)}`]),
    ...(run.hooksBlocked > 0 ? [`${run.hooksBlocked} blocked by hooks`] : []),
    ...(run.outsideMayChange ? [`${run.outsideMayChange} outside May change`] : []),
    ...(run.quiet
      ? [`quiet ${run.lastActivityAt === null ? "" : elapsed(run.lastActivityAt, now)}`]
      : []),
  ];
  const budget =
    activeStates.has(run.state) && run.turnStartedAt !== null
      ? [
          `budget ${elapsed(run.turnStartedAt, now)}/${run.turnBudgetMs === null ? "unlimited" : age(run.turnBudgetMs)}`,
        ]
      : [];
  return [
    [
      run.name,
      `${run.state} ${elapsed(run.stateSince, now)}`,
      `turn ${run.turn}${run.turnKind === null ? "" : ` (${run.turnKind})`}`,
      `${run.model} ${run.effort} ${run.tier} ${run.sandbox}`,
      ...budget,
      ...flags,
    ].join("  "),
    ...(run.activity === null
      ? []
      : [
          `  ${run.activity.kind}: ${oneLine(run.activity.text)} · ${elapsed(run.activity.since, now)} ago`,
        ]),
    ...run.subagents.map(
      (agent) =>
        `  ${agent.path}  ${agent.state} · ${elapsed(agent.lastInteractionAt, now)} ago${agent.model !== null && agent.model !== run.model ? ` · ${agent.model}` : ""}${agent.effort !== null && agent.effort !== run.effort ? ` · ${agent.effort}` : ""}`,
    ),
    ...run.warnings.map((warning) => `  warning: ${oneLine(warning)}`),
    ...(own
      ? [
          ...run.questions.map(
            (question) => `  next: ${executable} answer ${run.name} ${question.id} "<answer>"`,
          ),
          ...(run.quiet ? [`  next: ${executable} events ${run.name} --follow`] : []),
          ...(["idle", "interrupted", "failed"].includes(run.state)
            ? [`  next: ${executable} result ${run.name}`]
            : []),
        ]
      : []),
  ];
}

export function renderOverview(result: Overview, group: string, executable: string, now: number) {
  const counts = new Map<string, number>();
  const groups = new Map<string, RunView[]>();
  for (const run of result.runs) {
    counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
    const entries = groups.get(run.group) ?? [];
    entries.push(run);
    groups.set(run.group, entries);
  }
  return [
    `${result.runs.length} runs${
      counts.size === 0
        ? ""
        : `: ${[...counts]
            .sort()
            .map(([state, count]) => `${count} ${state}`)
            .join(", ")}`
    }`,
    ...[...groups]
      .sort(([a], [b]) => {
        if (a === group) return -1;
        if (b === group) return 1;
        return a.localeCompare(b);
      })
      .flatMap(([repoGroup, runs]) => [
        "",
        `${runs[0]?.repo} (${repoGroup})${repoGroup === group ? "" : " · other repo: its own session supervises it"}`,
        ...runs
          .sort((a, b) => a.name.localeCompare(b.name))
          .flatMap((run) => runLines(run, repoGroup === group, executable, now)),
      ]),
  ].join("\n");
}
