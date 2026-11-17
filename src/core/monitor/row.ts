import type { RunView } from "../../schemas/monitor";
import type { FlagView, RowView } from "./model";
import { pace } from "./pace";

/** Formats an elapsed interval as a compact, bounded terminal duration. */
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds >= 365 * 86400) return `${Math.min(9999, Math.floor(seconds / (365 * 86400)))}y`;
  if (seconds >= 10 * 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 10 * 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
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
    modelLabel: `${model} · ${effort}`.replace(/\p{Cc}/gu, " "),
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
