import { DateTime } from "effect";
import { activeStates } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import type { MonitorFeed } from "./feed";

export const OLDER_IDLE_MS = 24 * 60 * 60_000;
export type Tone =
  | "fg"
  | "muted"
  | "line"
  | "signal"
  | "running"
  | "done"
  | "failed"
  | "interrupted";
export type Defaults = Pick<RunView, "model" | "effort" | "tier">;
export type FlagView = { readonly text: string; readonly tone: Tone };
export type RowView = {
  readonly name: string;
  readonly state: RunView["state"];
  readonly turn: number;
  readonly turnKind: RunView["turnKind"];
  readonly activityAge: string | null;
  readonly tone: Tone;
  readonly age: string;
  readonly activity: string;
  readonly activityTone: Tone;
  readonly flags: readonly FlagView[];
  readonly budget: { readonly filled: number; readonly label: string; readonly tone: Tone } | null;
  readonly subagents: readonly { path: string; working: boolean; text: string }[];
};
export type GroupView = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly rows: readonly RowView[];
  readonly older: { readonly id: string; readonly text: string } | null;
};
export type ViewModel = {
  readonly columns: number;
  readonly rows: number;
  readonly now: number;
  readonly layout: "narrow" | "medium" | "wide";
  readonly budgetCells: number;
  readonly screen: "probing" | "list" | "empty" | "saved" | "outdated" | "reconnecting";
  readonly message: readonly string[];
  readonly header: {
    version: string;
    daemon: string;
    defaults: string;
    counts: readonly { state: string; count: number; tone: Tone }[];
    caution: boolean;
  };
  readonly notes: readonly { id: string; title: string; text: string; command: string }[];
  readonly moreNotes: number;
  readonly groups: readonly GroupView[];
  readonly selected: string | null;
  readonly footer: { compact: boolean; status: string; caution: boolean; attentionOnly: boolean };
  readonly overlay: boolean;
  readonly animating: boolean;
  readonly offset: number;
};
export type State = {
  readonly group: string;
  readonly defaults: Defaults;
  readonly version: string;
  readonly now: number;
  readonly columns: number;
  readonly rows: number;
  readonly feed: MonitorFeed | null;
  readonly selected: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly attentionOnly: boolean;
  readonly help: boolean;
  readonly scroll: number | null;
};
export type Message =
  | { readonly type: "feed"; readonly value: MonitorFeed }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "resize"; readonly columns: number; readonly rows: number };
export const initialState = (
  options: Pick<State, "group" | "defaults" | "version" | "now" | "columns" | "rows">,
): State => ({
  ...options,
  feed: null,
  selected: null,
  expanded: new Set(),
  attentionOnly: false,
  help: false,
  scroll: null,
});
const epoch = DateTime.toEpochMillis;
const oneLine = (text: string) => text.split(/\r?\n/, 1)[0]?.replace(/\p{Cc}/gu, " ") ?? "";
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds >= 365 * 86400) return `${Math.min(9999, Math.floor(seconds / (365 * 86400)))}y`;
  if (seconds >= 10 * 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 10 * 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}
const age = (at: DateTime.Utc, now: number) => duration(now - epoch(at));
export function stateTone(state: RunView["state"]): Tone {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "signal";
    case "idle":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "unknown":
      return "interrupted";
    case "starting":
    case "lost":
      return "muted";
  }
}
function flags(run: RunView, state: State): FlagView[] {
  const result: FlagView[] = [];
  for (const q of run.questions)
    result.push({ text: `${q.id} pending ${age(q.askedAt, state.now)}`, tone: "signal" });
  if (run.unansweredCount > 0)
    result.push({ text: `${run.unansweredCount} deferred`, tone: "interrupted" });
  if (run.quiet && run.state === "running" && run.activity?.kind !== "command")
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
const activityTime = (run: RunView) => epoch(run.lastActivityAt ?? run.stateSince);
const isOlder = (run: RunView, now: number) =>
  run.state === "idle" && now - epoch(run.stateSince) > OLDER_IDLE_MS;
function needsAttention(run: RunView, state: State) {
  return (
    flags(run, state).some((flag) => flag.tone !== "muted") ||
    ["waiting", "failed", "interrupted", "lost", "unknown"].includes(run.state) ||
    (activeStates.has(run.state) &&
      run.turnBudgetMs !== null &&
      run.turnStartedAt !== null &&
      state.now - epoch(run.turnStartedAt) >= run.turnBudgetMs)
  );
}
function grouped(state: State) {
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  const groups = new Map<string, RunView[]>();
  for (const run of overview?.runs ?? []) {
    if (state.attentionOnly && !needsAttention(run, state)) continue;
    const entries = groups.get(run.group) ?? [];
    entries.push(run);
    groups.set(run.group, entries);
  }
  return [...groups]
    .sort(([a, left], [b, right]) => {
      if (a === state.group) return -1;
      if (b === state.group) return 1;
      return (
        Math.max(...right.map(activityTime)) - Math.max(...left.map(activityTime)) ||
        a.localeCompare(b)
      );
    })
    .map(([id, runs]) => ({
      id,
      runs: runs.sort((a, b) => activityTime(b) - activityTime(a) || a.name.localeCompare(b.name)),
    }));
}
function selectable(state: State) {
  return grouped(state).flatMap(({ id, runs }) => [
    ...runs
      .filter((run) => !isOlder(run, state.now) || state.expanded.has(id))
      .map((run) => run.name),
    ...(runs.some((run) => isOlder(run, state.now)) && !state.expanded.has(id)
      ? [`older:${id}`]
      : []),
  ]);
}
export function reduce(state: State, msg: Message): State {
  let next: State;
  if (msg.type === "tick") {
    if (Math.floor(state.now / 1000) === Math.floor(msg.now / 1000)) return state;
    next = { ...state, now: msg.now };
  } else if (msg.type === "feed")
    next = {
      ...state,
      feed: msg.value,
      now:
        msg.value._tag === "Reconnecting" ? state.now : Math.max(state.now, msg.value.receivedAt),
    };
  else if (msg.type === "resize")
    next = { ...state, columns: Math.max(1, msg.columns), rows: Math.max(3, msg.rows) };
  else {
    if (msg.key === "?" || (state.help && msg.key === "escape"))
      return { ...state, help: !state.help };
    if (state.help) return state;
    if (msg.key === "page-up" || msg.key === "page-down")
      return {
        ...state,
        scroll: Math.max(
          0,
          view(state).offset + (msg.key === "page-up" ? -1 : 1) * Math.max(1, state.rows - 2),
        ),
      };
    if (msg.key === "a") next = { ...state, attentionOnly: !state.attentionOnly };
    else if (msg.key === "enter" && state.selected?.startsWith("older:"))
      next = { ...state, expanded: new Set([...state.expanded, state.selected.slice(6)]) };
    else {
      const keys = selectable(state);
      const index = Math.max(0, keys.indexOf(state.selected ?? ""));
      let target = index;
      if (["j", "down"].includes(msg.key)) target = Math.min(keys.length - 1, index + 1);
      else if (["k", "up"].includes(msg.key)) target = Math.max(0, index - 1);
      else if (msg.key === "home") target = 0;
      else if (msg.key === "end") target = keys.length - 1;
      else return state;
      return { ...state, selected: keys[target] ?? null, scroll: msg.key === "home" ? 0 : null };
    }
  }
  const keys = selectable(next);
  if (next.selected !== null && keys.includes(next.selected)) return next;
  const collapsed = grouped(next).find((group) =>
    group.runs.some((run) => run.name === next.selected),
  );
  if (collapsed && keys.includes(`older:${collapsed.id}`))
    return { ...next, selected: `older:${collapsed.id}`, scroll: null };
  const previousIndex = Math.max(0, selectable(state).indexOf(state.selected ?? ""));
  return { ...next, selected: keys[Math.min(previousIndex, keys.length - 1)] ?? null };
}
function row(run: RunView, state: State, cells: number): RowView {
  let budget: RowView["budget"] = null;
  if (activeStates.has(run.state) && run.turnStartedAt !== null && run.turnBudgetMs !== null) {
    const elapsed = Math.max(0, state.now - epoch(run.turnStartedAt));
    const fraction = run.turnBudgetMs === 0 ? 1 : elapsed / run.turnBudgetMs;
    let tone: Tone = "running";
    if (fraction >= 1) tone = "failed";
    else if (fraction >= 0.8) tone = "interrupted";
    budget = {
      filled: Math.min(cells, Math.floor(fraction * cells)),
      label: `${Math.floor(elapsed / 60000)}/${Math.floor(run.turnBudgetMs / 60000)}m`,
      tone,
    };
  }
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
  const urgent =
    allFlags.find((flag) => flag.tone === "signal") ??
    allFlags.find((flag) => flag.tone === "failed") ??
    allFlags[0];
  return {
    name: run.name,
    state: run.state,
    turn: run.turn,
    turnKind: run.turnKind,
    activityAge: activity?.kind === "command" ? age(activity.since, state.now) : null,
    tone: stateTone(run.state),
    age: age(run.stateSince, state.now).padStart(5),
    activity: text,
    activityTone,
    budget,
    flags: cells === 0 ? allFlags.filter((flag) => flag === urgent) : allFlags,
    subagents: run.subagents.map((agent) => ({
      path: oneLine(agent.path),
      working: agent.state === "working",
      text: `${agent.state} · ${age(agent.lastInteractionAt, state.now)} ago${agent.model !== null && agent.model !== run.model ? ` · ${oneLine(agent.model)}` : ""}${agent.effort !== null && agent.effort !== run.effort ? ` · ${oneLine(agent.effort)}` : ""}`,
    })),
  };
}
export function view(state: State, previous?: ViewModel): ViewModel {
  const { feed } = state;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  const runs = overview?.runs ?? [];
  let layout: ViewModel["layout"] = "narrow";
  let cells = 0;
  if (state.columns >= 120) {
    layout = "wide";
    cells = 10;
  } else if (state.columns >= 80) {
    layout = "medium";
    cells = 6;
  }
  const oldRows = new Map(
    previous?.groups.flatMap((group) => group.rows.map((entry) => [entry.name, entry] as const)),
  );
  const groups = grouped(state).map(({ id, runs: entries }): GroupView => {
    const older = entries.filter((run) => isOlder(run, state.now));
    const counts = new Map<string, number>();
    for (const run of entries) counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
    return {
      id,
      title: oneLine(entries[0]?.repo.split("/").filter(Boolean).at(-1) ?? id),
      summary: [...counts].map(([name, count]) => `${count} ${name}`).join(" · "),
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
  const notes = grouped(state).flatMap(({ runs: entries }) =>
    entries.flatMap((run) =>
      run.questions.map((q) => ({
        id: `${run.name}:${q.id}`,
        title: `■ waiting  ${run.name} ${q.id} · ${age(q.askedAt, state.now)}${q.defersAt === null ? "" : ` · defers in ${duration(epoch(q.defersAt) - state.now)}`}`,
        text: oneLine(q.text),
        command:
          run.group === state.group
            ? `foreman answer ${run.name} ${q.id} --file <path>`
            : "other repo: its own session supervises it",
      })),
    ),
  );
  let screen: ViewModel["screen"] = "list";
  let message: readonly string[] = [];
  if (feed === null) {
    screen = "probing";
    message = ["Connecting to daemon", "Reading current runs", "foreman status --all"];
  } else if (feed._tag === "Saved") {
    screen = feed.reason === "outdated" ? "outdated" : "saved";
    message = [
      feed.reason === "outdated"
        ? "Saved state · daemon is outdated"
        : "Saved state · daemon not running",
      feed.reason === "outdated"
        ? "The monitor will reconnect when a compatible daemon is available."
        : "The monitor checks again automatically; start work in another terminal.",
      "foreman status --all",
    ];
  } else if (feed._tag === "Reconnecting") {
    screen = "reconnecting";
    message = ["Reconnecting to daemon", oneLine(feed.reason), "foreman status --all"];
  } else if (runs.length === 0 || groups.length === 0) {
    screen = "empty";
    message = [
      state.attentionOnly ? "No runs need attention" : "No runs yet",
      state.attentionOnly ? "Press a to show every run." : "Start a run in another terminal.",
      "foreman start --help",
    ];
  }
  const counts = new Map<RunView["state"], number>();
  for (const run of runs) counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
  const limit = state.rows < 24 ? 1 : 3;
  const reconnecting = feed?._tag === "Reconnecting";
  let daemon = "connecting";
  if (feed?._tag === "Saved") daemon = "daemon not running · saved state";
  else if (overview?.daemon) daemon = `daemon up ${age(overview.daemon.startedAt, state.now)}`;
  if (screen === "outdated") daemon = "daemon outdated · saved state";
  const visibleNotes = notes.slice(0, limit);
  const moreNotes = Math.max(0, notes.length - limit);
  const available = Math.max(1, state.rows - 2);
  let position = message.length + visibleNotes.length * 4 + (moreNotes > 0 ? 1 : 0);
  const spans: { start: number; end: number; id: string }[] = [];
  const animatedLines: number[] = visibleNotes.map((_, index) => message.length + index * 4);
  const boundaries = [0];
  for (const group of groups) {
    boundaries.push(++position);
    for (const entry of group.rows) {
      const start = position;
      position += 2 + (layout === "narrow" ? 0 : entry.subagents.length);
      spans.push({ start, end: position, id: entry.name });
      if (["running", "starting", "waiting"].includes(entry.state)) animatedLines.push(start);
      if (layout !== "narrow")
        for (const [index, agent] of entry.subagents.entries())
          if (agent.working) animatedLines.push(start + 2 + index);
      boundaries.push(position);
    }
    if (group.older) {
      spans.push({ start: position, end: position + 1, id: group.older.id });
      boundaries.push(++position);
    }
  }
  const selectedSpan = spans.find((span) => span.id === state.selected);
  const target = selectedSpan === spans[0] ? 0 : Math.max(0, (selectedSpan?.end ?? 0) - available);
  const automaticOffset = Math.min(
    selectedSpan?.start ?? 0,
    boundaries.find((boundary) => boundary >= target) ?? target,
  );
  const offset =
    state.scroll === null
      ? automaticOffset
      : Math.min(state.scroll, Math.max(0, position - available));
  return {
    columns: state.columns,
    rows: state.rows,
    now: state.now,
    layout,
    budgetCells: cells,
    screen,
    message,
    header: {
      version: state.version,
      daemon,
      defaults: `${state.defaults.model} · ${state.defaults.effort} · ${state.defaults.tier === "priority" ? "fast" : state.defaults.tier}`,
      counts: [...counts].map(([s, count]) => ({ state: s, count, tone: stateTone(s) })),
      caution: feed?._tag === "Saved" || reconnecting,
    },
    notes: visibleNotes,
    moreNotes,
    groups,
    selected: state.selected,
    footer: {
      compact: state.rows < 24,
      status: reconnecting
        ? `reconnecting in ${Math.max(0, Math.ceil((feed.retryAt - state.now) / 1000))}s`
        : `updated ${(Math.max(0, state.now - (feed?.receivedAt ?? state.now)) / 1000).toFixed(1)}s ago`,
      caution: reconnecting,
      attentionOnly: state.attentionOnly,
    },
    overlay: state.help,
    offset,
    animating:
      !state.help &&
      (feed === null ||
        (reconnecting && state.rows >= 24) ||
        animatedLines.some((line) => line >= offset && line < offset + available)),
  };
}
