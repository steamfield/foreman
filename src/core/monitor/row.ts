import { DateTime } from "effect";
import { activeStates } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import { age, oneLine, stateTone, unsupervised } from "./format";
import type { FlagView, RowView, State, Tone } from "./model-types";
import { pace } from "./pace";

/** Names the provider ahead of the model for non-Codex runs; Codex runs get no tag. */
export function providerTag(run: Pick<RunView, "provider">): string {
  return run.provider === undefined || run.provider === "codex" ? "" : `${run.provider} `;
}

/** Builds the task, model, progress and pace facts shared by list layouts. */
export function rowFacts(
  run: RunView,
  live: boolean,
): Pick<RowView, "task" | "modelLabel" | "progress" | "pace" | "review"> {
  const model = run.model.replace(/^gpt-\d+(?:\.\d+)*-/, "");
  const effort = run.effort === "medium" ? "med" : run.effort;
  return {
    review: reviewHint(run),
    task: run.title?.replace(/\p{Cc}/gu, " ") ?? null,
    modelLabel: `${providerTag(run)}${model} · ${effort}`.replace(/\p{Cc}/gu, " "),
    progress:
      run.commands === null
        ? null
        : {
            text: `t${run.turn} · ${run.commands.total} cmds`,
            failed: run.commands.failed,
          },
    pace: pace(run, live),
  };
}

function reviewHint(run: RunView): RowView["review"] {
  if (!["idle", "failed", "interrupted"].includes(run.state)) return null;
  if (run.reviewedAt !== null) return { text: "reviewed", key: null, bold: false, tone: "muted" };
  return run.filesWritten
    ? { text: `${run.filesWritten} files · r review`, key: "r", bold: true, tone: "fg" }
    : null;
}

/** Keeps the most urgent row flag readable in the compact list. */
export function compactFlags(
  flags: readonly FlagView[],
  review: RowView["review"],
  percent: number,
): FlagView[] {
  const urgent =
    flags.find((flag) => flag.tone === "signal") ??
    flags.find((flag) => flag.tone === "failed") ??
    flags.find((flag) => flag.tone === "interrupted");
  if (urgent)
    return [
      {
        ...urgent,
        text: urgent.text
          .replace(/ pending.*$/, "")
          .replace(/^(\d+) hooks blocked$/, "$1 hooks")
          .replace(/^(\d+) outside scope$/, "$1 scope")
          .replace(/retrying \(.*\)/, "retrying"),
      },
    ];
  if (percent >= 80)
    return [{ text: `${percent}%`, tone: percent >= 100 ? "failed" : "interrupted" }];
  if (review) return [{ text: review.key ? "review" : "reviewed", tone: review.tone }];
  return flags[0] ? [flags[0]] : [];
}

const epoch = DateTime.toEpochMillis;
function flags(run: RunView, state: State): FlagView[] {
  const result: FlagView[] = [];
  for (const q of run.questions)
    result.push({ text: `${q.id} pending ${age(q.askedAt, state.now)}`, tone: "signal" });
  if (run.unansweredCount > 0)
    result.push({ text: `${run.unansweredCount} deferred`, tone: "interrupted" });
  if (
    !unsupervised(state.feed) &&
    run.quiet &&
    run.state === "running" &&
    run.activity?.kind !== "command"
  )
    result.push({
      text: `quiet ${run.lastActivityAt === null ? "" : age(run.lastActivityAt, state.now)}`.trim(),
      tone: "interrupted",
    });
  if (run.retrying)
    result.push({ text: `retrying (${oneLine(run.retrying.message)})`, tone: "interrupted" });
  if (run.hooksBlocked > 0)
    result.push({ text: `${run.hooksBlocked} hooks blocked`, tone: "failed" });
  if (run.outsideMayChange)
    result.push({ text: `${run.outsideMayChange} outside scope`, tone: "interrupted" });
  for (const key of ["model", "effort", "tier"] as const) {
    if (run[key] !== state.defaults[key])
      result.push({ text: `${key} ${oneLine(run[key])}`, tone: "muted" });
  }
  // Delegates normally write, so only a read-only run is worth a flag.
  if (run.sandbox === "read-only") result.push({ text: "read-only", tone: "muted" });
  return result;
}
/** Builds the two-line run row and its optional subagent rows. */
export function row(run: RunView, state: State, cells: number): RowView {
  const stale = unsupervised(state.feed) && activeStates.has(run.state);
  const { budget, percent } = rowBudget(run, state.now, cells, stale);
  const activity = run.activity;
  let text = "";
  let activityTone: Tone = "muted";
  if (activity?.kind === "command") {
    text = `… ${oneLine(activity.text)}`;
    activityTone = "fg";
  } else if (activity?.kind === "message") text = `“${oneLine(activity.text)}”`;
  else if (activity)
    text = `${activity.kind === "failure" ? "failed" : "done"}: ${oneLine(activity.text)}`;
  const allFlags = flags(run, state);
  const facts = rowFacts(run, state.feed?._tag === "Live");
  return {
    name: run.name,
    stale,
    state: run.state,
    turn: run.turn,
    turnKind: run.turnKind,
    activityAge: activity?.kind === "command" ? age(activity.since, state.now) : null,
    tone: stale ? "muted" : stateTone(run.state),
    age: age(run.stateSince, state.now).padStart(5),
    activity: text,
    activityTone,
    budget,
    flags: state.columns < 100 ? compactFlags(allFlags, facts.review, percent) : allFlags,
    subagents: run.subagents.map((agent) => ({
      path: oneLine(agent.path),
      working: !unsupervised(state.feed) && agent.state === "working",
      text: `${agent.state} · ${age(agent.lastInteractionAt, state.now)} ago${agent.model !== null && agent.model !== run.model ? ` · ${oneLine(agent.model)}` : ""}${agent.effort !== null && agent.effort !== run.effort ? ` · ${oneLine(agent.effort)}` : ""}`,
    })),
    ...facts,
  };
}

function rowBudget(run: RunView, now: number, cells: number, stale: boolean) {
  let budget: RowView["budget"] = null;
  let percent = 0;
  if (
    !stale &&
    activeStates.has(run.state) &&
    run.turnStartedAt !== null &&
    run.turnBudgetMs !== null
  ) {
    const elapsed = Math.max(0, now - epoch(run.turnStartedAt));
    const fraction = run.turnBudgetMs === 0 ? 1 : elapsed / run.turnBudgetMs;
    percent = Math.floor(fraction * 100);
    let tone: Tone = "running";
    if (fraction >= 1) tone = "failed";
    else if (fraction >= 0.8) tone = "interrupted";
    budget = {
      filled: Math.min(cells, Math.floor(fraction * cells)),
      label: `${Math.floor(elapsed / 60000)}/${Math.floor(run.turnBudgetMs / 60000)}m`,
      tone,
    };
  }
  return { budget, percent };
}
