import { DateTime } from "effect";
import type { RunView } from "../../schemas/monitor";
import { matchesRun } from "./filter";
import type { State } from "./model";

const stateOrder = [
  "waiting",
  "running",
  "starting",
  "failed",
  "interrupted",
  "unknown",
  "lost",
  "idle",
];
const activityTime = (run: RunView) => DateTime.toEpochMillis(run.lastActivityAt ?? run.stateSince);

/** Returns the next grouping mode in the monitor's cycle. */
export function nextGrouping(grouping: State["grouping"]): State["grouping"] {
  if (grouping === "repo") return "state";
  return grouping === "state" ? "recent" : "repo";
}

/** Groups and orders current runs, optionally retaining rows hidden by the filter. */
export function listGroups(state: State, filtered = true) {
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  const groups = new Map<string, RunView[]>();
  for (const run of overview?.runs ?? []) {
    let id = run.group;
    if (state.grouping === "state") id = run.state;
    if (state.grouping === "recent") id = "recent";
    const entries = groups.get(id) ?? [];
    entries.push(run);
    groups.set(id, entries);
  }
  return [...groups]
    .sort(([a, left], [b, right]) => {
      if (state.grouping === "state") return stateOrder.indexOf(a) - stateOrder.indexOf(b);
      if (a === state.group) return -1;
      if (b === state.group) return 1;
      return (
        Math.max(...right.map(activityTime)) - Math.max(...left.map(activityTime)) ||
        a.localeCompare(b)
      );
    })
    .map(([id, entries]) => {
      const runs = entries.filter((run) => !filtered || matchesRun(run, state));
      runs.sort((a, b) => {
        const time =
          state.grouping === "recent"
            ? DateTime.toEpochMillis(b.stateSince) - DateTime.toEpochMillis(a.stateSince)
            : activityTime(b) - activityTime(a);
        return time || a.name.localeCompare(b.name);
      });
      return {
        id,
        runs,
        hidden: state.filter.text.trim() ? entries.length - runs.length : 0,
        title:
          state.grouping === "repo"
            ? (entries[0]?.repo.split("/").filter(Boolean).at(-1) ?? id)
            : id,
      };
    });
}
