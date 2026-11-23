import { DateTime } from "effect";
import type { ActView } from "./act";
import { eligible, findRun } from "./act-target";
import { duration } from "./format";
import type { State } from "./model-types";

/** Builds the open confirm's facts and keys from the latest available run data. */
export function confirmView(state: State): ActView["confirm"] {
  const overlay = state.act.overlay;
  if (overlay?.kind === "confirm-acting")
    return {
      title: "Switch to acting?",
      lines: [
        "Acting keeps the daemon running while this monitor is open.",
        "Press w to return to watching.",
      ],
      keys: [
        { key: "y", label: "confirm" },
        { key: "n", label: "cancel" },
      ],
    };
  if (overlay?.kind !== "confirm-interrupt" && overlay?.kind !== "confirm-archive") return null;
  const run = findRun(state, overlay.name);
  if (overlay.kind === "confirm-archive")
    return {
      title: `Archive ${overlay.name}?`,
      lines: [
        `worktree ${run?.worktree ?? "unavailable"}`,
        `branch ${run?.branch ?? "none"}`,
        "Removes the worktree and branch; the run record moves to the archive. Uncommitted changes in the worktree are lost.",
      ],
      keys: [
        { key: "y", label: "archive" },
        { key: "k", label: "keep worktree" },
        { key: "n", label: "cancel" },
      ],
    };
  return {
    title: `Interrupt ${overlay.name}?`,
    lines: interruptLines(state, run),
    keys: [
      { key: "y", label: "interrupt" },
      ...(run && eligible("steer", run) ? [{ key: "s", label: "steer instead" }] : []),
      { key: "n", label: "cancel" },
    ],
  };
}

function interruptLines(state: State, run: ReturnType<typeof findRun>): string[] {
  const lines = [
    `Stops turn ${run?.turn ?? "unknown"} now. The delegate writes a hand-off; the worktree and branch stay.`,
  ];
  if (run?.activity?.kind === "command")
    lines.push(
      `The open command ${run.activity.text.replace(/\p{Cc}/gu, " ")} · running ${duration(state.now - DateTime.toEpochMillis(run.activity.since))}, will be killed`,
    );
  const feed = state.detail?.feed;
  let data = null;
  if (feed?._tag === "Reconnecting") data = feed.last;
  else if (feed && feed._tag !== "Archived") data = feed.detail;
  if (run?.turnBudgetMs !== null && run?.turnBudgetMs !== undefined) {
    const elapsed =
      run.turnStartedAt === null ? 0 : state.now - DateTime.toEpochMillis(run.turnStartedAt);
    const commands = data?.run.name === run.name ? ` · ${data.digest.commands.total} commands` : "";
    lines.push(`used ${duration(elapsed)} of ${duration(run.turnBudgetMs)}${commands}`);
  }
  if (run?.outsideMayChange)
    lines.push(
      `${run.outsideMayChange} ${run.outsideMayChange === 1 ? "file" : "files"} outside scope`,
    );
  lines.push("The session that started this run will see it as interrupted from foreman monitor.");
  return lines;
}
