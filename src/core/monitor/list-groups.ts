import { DateTime } from "effect";
import type { RunView } from "../../schemas/monitor";
import { matchesRun } from "./filter";
import { oneLine } from "./format";
import type { GroupView, State, ViewModel } from "./model-types";
import { row } from "./row";

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

/** Age after which idle runs collapse under an older-runs row. */
export const OLDER_IDLE_MS = 24 * 60 * 60_000;
/** Identifies idle runs that belong in the collapsed older section. */
export const isOlder = (run: RunView, now: number) =>
  run.state === "idle" && now - DateTime.toEpochMillis(run.stateSince) > OLDER_IDLE_MS;
/** Orders all groups and runs for attention notes and action targeting, regardless of the filter. */
export function grouped(state: State) {
  return listGroups(state, false);
}

/** Builds grouped rows while retaining unchanged row references. */
export function groupViews(state: State, cells: number, previous?: ViewModel): GroupView[] {
  const oldRows = new Map(
    previous?.groups.flatMap((group) => group.rows.map((entry) => [entry.name, entry] as const)),
  );
  return listGroups(state).map(({ id, runs: entries, hidden, title }): GroupView => {
    const older = entries.filter((run) => isOlder(run, state.now));
    const counts = new Map<string, number>();
    for (const run of entries) counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
    return {
      id,
      title: oneLine(title),
      summary:
        hidden > 0
          ? `${entries.length} shown · ${hidden} hidden by filter`
          : [...counts].map(([name, count]) => `${count} ${name}`).join(" · "),
      rows: entries
        .filter((run) => !isOlder(run, state.now) || state.expanded.has(id))
        .map((run) => {
          const next = row(run, state, cells);
          const previousRow = oldRows.get(next.name);
          return previousRow && JSON.stringify(previousRow) === JSON.stringify(next)
            ? previousRow
            : next;
        }),
      older:
        older.length > 0 && !state.expanded.has(id)
          ? {
              id: `older:${id}`,
              text: `· ${older.length} idle ${older.length === 1 ? "run" : "runs"} older than 24h`,
            }
          : null,
    };
  });
}
