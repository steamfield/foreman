import { DateTime } from "effect";
import { activeStates, type RunEvent, type RunName } from "../../schemas/daemon";
import type { Detail, RunView } from "../../schemas/monitor";
import { tokenCount } from "../runs/digest";
import { type ActMessage, type ActState, type ActView, initialAct, reduceAct } from "./act";
import { actView } from "./act-view";
import { firstProseLine, shellCommand } from "./attention";
import type { DetailFeed } from "./detail-feed";
import type { MonitorFeed } from "./feed";

export const OLDER_IDLE_MS = 24 * 60 * 60_000;
export const EVENT_BUFFER_LIMIT = 1000;
export const DETAIL_PANES = [
  "task",
  "digest",
  "questions",
  "subagents",
  "handoff",
  "commands",
  "feed",
] as const;
export type PaneId = (typeof DETAIL_PANES)[number];
export type DetailLine = {
  readonly text: string;
  readonly tone: Tone;
  readonly kind?: "working" | "subagent-idle";
  readonly at?: string;
  readonly symbol?: string;
  readonly frame?: "top" | "body" | "bottom";
};
export type PaneView = {
  readonly id: PaneId;
  readonly title: string;
  readonly value: string;
  readonly lines: readonly DetailLine[];
  readonly height: number;
  readonly offset: number;
  readonly focused: boolean;
};
export type DetailView = {
  readonly name: string;
  readonly stale: boolean;
  readonly state: RunView["state"] | null;
  readonly tone: Tone;
  readonly status: "loading" | "ready" | "archived" | "reconnecting";
  readonly message: readonly string[];
  readonly header: readonly (readonly [string, string])[];
  readonly warnings: readonly string[];
  readonly panes: readonly PaneView[];
  readonly focus: PaneId;
};
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
  readonly stale: boolean;
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
  readonly detail: DetailView | null;
  readonly act: ActView;
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
  readonly detail: {
    readonly name: RunName;
    readonly feed: DetailFeed | null;
    readonly events: readonly RunEvent[];
    readonly gap: boolean;
    readonly dropped: number;
    readonly focus: PaneId;
    readonly offsets: Readonly<Record<PaneId, number>>;
    readonly follow: boolean;
  } | null;
  readonly act: ActState;
};
export type Message =
  | { readonly type: "feed"; readonly value: MonitorFeed }
  | { readonly type: "detail-feed"; readonly name: RunName; readonly value: DetailFeed }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "resize"; readonly columns: number; readonly rows: number }
  | ActMessage;
export const initialState = (
  options: Pick<State, "group" | "defaults" | "version" | "now" | "columns" | "rows"> & {
    readonly name?: RunName;
  },
): State => ({
  ...options,
  feed: null,
  selected: null,
  expanded: new Set(),
  attentionOnly: false,
  help: false,
  scroll: null,
  act: initialAct,
  detail: options.name === undefined ? null : openDetail(options.name),
});
function openDetail(name: RunName): NonNullable<State["detail"]> {
  return {
    name,
    feed: null,
    events: [],
    gap: false,
    dropped: 0,
    focus: "task",
    follow: true,
    offsets: { task: 0, digest: 0, questions: 0, subagents: 0, handoff: 0, commands: 0, feed: 0 },
  };
}
const epoch = DateTime.toEpochMillis;
const cleanText = (text: string) => text.replace(/\p{Cc}/gu, " ");
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
const two = (value: number) => String(value).padStart(2, "0");
/** Local wall-clock time, HH:MM:SS. */
export function clockTime(at: DateTime.Utc): string {
  const date = new Date(epoch(at));
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
/** Local time with the date when it is not today, then the age. */
function stamp(at: DateTime.Utc, now: number): string {
  const date = new Date(epoch(at));
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return `${sameDay ? "" : `${day} `}${clockTime(at)} · ${age(at, now)} ago`;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
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
const unsupervised = (feed: MonitorFeed | DetailFeed | null | undefined) =>
  feed?._tag === "Saved" && feed.reason === "no-daemon";
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
/** Orders visible groups and runs for both the list and attention targeting. */
export function grouped(state: State) {
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
  if (
    msg.type === "key" ||
    msg.type === "draft" ||
    msg.type === "act-outcome" ||
    msg.type === "acting-lost"
  ) {
    const acted = reduceAct(state, msg);
    if (acted !== null) return acted;
  }
  if (msg.type === "key" && state.act.notice !== null)
    state = { ...state, act: { ...state.act, notice: null } };
  let next: State;
  if (msg.type === "detail-feed") {
    let detail = state.detail;
    if (!detail || detail.name !== msg.name) return state;
    const data = currentDetail(state);
    let incomingDetail: Detail | null = null;
    if (msg.value._tag === "Live" || msg.value._tag === "Saved") incomingDetail = msg.value.detail;
    else if (msg.value._tag === "Reconnecting") incomingDetail = msg.value.last;
    if (
      msg.value._tag === "Archived" ||
      (data &&
        incomingDetail &&
        epoch(data.record.createdAt) !== epoch(incomingDetail.record.createdAt))
    )
      detail = { ...openDetail(detail.name), focus: detail.focus, follow: detail.follow };
    const incoming =
      msg.value._tag === "Live" || msg.value._tag === "Saved" ? msg.value.events : [];
    const lastSeq = detail.events.at(-1)?.seq ?? 0;
    const appended = [...detail.events, ...incoming.filter((entry) => entry.seq > lastSeq)];
    const dropped = Math.max(0, appended.length - EVENT_BUFFER_LIMIT);
    const gap =
      detail.gap || ((msg.value._tag === "Live" || msg.value._tag === "Saved") && msg.value.gap);
    const removedLines = data ? feedLines(detail.events.slice(0, dropped), data).length : 0;
    const addedMarkers = Number(!detail.gap && gap) + Number(detail.dropped === 0 && dropped > 0);
    return {
      ...state,
      now:
        msg.value._tag === "Reconnecting" ? state.now : Math.max(state.now, msg.value.receivedAt),
      detail: {
        ...detail,
        feed: msg.value,
        events: appended.slice(-EVENT_BUFFER_LIMIT),
        dropped: detail.dropped + dropped,
        gap,
        offsets: {
          ...detail.offsets,
          feed: Math.max(0, detail.offsets.feed - removedLines + addedMarkers),
        },
      },
    };
  }
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
  else if (msg.type !== "key") return state;
  else {
    if (msg.key === "?" || (state.help && msg.key === "escape"))
      return { ...state, help: !state.help };
    if (state.help) return state;
    if (state.detail) {
      const detail = state.detail;
      if (msg.key === "escape") return { ...state, detail: null };
      if (msg.key === "tab" || msg.key === "\t")
        return {
          ...state,
          detail: {
            ...detail,
            focus:
              DETAIL_PANES[(DETAIL_PANES.indexOf(detail.focus) + 1) % DETAIL_PANES.length] ??
              "task",
          },
        };
      if (msg.key === "f") {
        const offset = detailView(state)?.panes.find((pane) => pane.id === "feed")?.offset ?? 0;
        return {
          ...state,
          detail: {
            ...detail,
            follow: !detail.follow,
            offsets: { ...detail.offsets, feed: offset },
          },
        };
      }
      const pane = detailView(state)?.panes.find((entry) => entry.id === detail.focus);
      if (!pane) return state;
      const page = Math.max(1, pane.height - 2);
      const maximum = Math.max(0, pane.lines.length - page);
      let offset = pane.offset;
      if (msg.key === "home") offset = 0;
      else if (msg.key === "end") offset = maximum;
      else if (["j", "down", "k", "up", "page-up", "page-down"].includes(msg.key)) {
        const up = ["k", "up", "page-up"].includes(msg.key);
        offset += (up ? -1 : 1) * (msg.key.startsWith("page-") ? page : 1);
      } else return state;
      return {
        ...state,
        detail: {
          ...detail,
          follow: detail.focus === "feed" && offset < pane.offset ? false : detail.follow,
          offsets: { ...detail.offsets, [detail.focus]: Math.max(0, Math.min(maximum, offset)) },
        },
      };
    }
    if (msg.key === "page-up" || msg.key === "page-down")
      return {
        ...state,
        scroll: Math.max(
          0,
          view(state).offset + (msg.key === "page-up" ? -1 : 1) * Math.max(1, state.rows - 2),
        ),
      };
    if (msg.key === "!") next = { ...state, attentionOnly: !state.attentionOnly };
    else if (msg.key === "enter" && state.selected?.startsWith("older:"))
      next = { ...state, expanded: new Set([...state.expanded, state.selected.slice(6)]) };
    else if (msg.key === "enter" && state.selected) {
      const run = grouped(state)
        .flatMap((group) => group.runs)
        .find((run) => run.name === state.selected);
      return run ? { ...state, detail: openDetail(run.name) } : state;
    } else {
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
  const stale = unsupervised(state.feed) && activeStates.has(run.state);
  let budget: RowView["budget"] = null;
  if (
    !stale &&
    activeStates.has(run.state) &&
    run.turnStartedAt !== null &&
    run.turnBudgetMs !== null
  ) {
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
    flags: cells === 0 ? allFlags.filter((flag) => flag === urgent) : allFlags,
    subagents: run.subagents.map((agent) => ({
      path: oneLine(agent.path),
      working: !unsupervised(state.feed) && agent.state === "working",
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
      state.attentionOnly ? "No runs need attention" : "No runs.",
      state.attentionOnly ? "Press ! to show every run." : "Start one with",
      state.attentionOnly ? "foreman start --help" : "foreman start",
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
  const animatedLines: number[] = unsupervised(feed)
    ? []
    : visibleNotes.map((_, index) => message.length + index * 4);
  const boundaries = [0];
  for (const group of groups) {
    boundaries.push(++position);
    for (const entry of group.rows) {
      const start = position;
      position += 2 + (layout === "narrow" ? 0 : entry.subagents.length);
      spans.push({ start, end: position, id: entry.name });
      if (!entry.stale && ["running", "starting", "waiting"].includes(entry.state))
        animatedLines.push(start);
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
  const detail = detailView(state);
  let footerStatus = reconnecting
    ? `reconnecting in ${Math.max(0, Math.ceil((feed.retryAt - state.now) / 1000))}s`
    : `updated ${(Math.max(0, state.now - (feed?.receivedAt ?? state.now)) / 1000).toFixed(1)}s ago`;
  let footerCaution = reconnecting;
  const detailFeed = state.detail?.feed;
  if (detailFeed?._tag === "Reconnecting") {
    footerStatus = `reconnecting in ${Math.max(0, Math.ceil((detailFeed.retryAt - state.now) / 1000))}s`;
    footerCaution = true;
  } else if (detailFeed?._tag === "Saved") {
    footerStatus =
      detailFeed.reason === "outdated" ? "saved · daemon outdated" : "saved · daemon not running";
    footerCaution = true;
  } else if (detailFeed?._tag === "Live") {
    footerStatus = `updated ${(Math.max(0, state.now - detailFeed.receivedAt) / 1000).toFixed(1)}s ago`;
    footerCaution = false;
  }
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
      counts: [...counts].map(([s, count]) => ({
        state: s,
        count,
        tone: unsupervised(feed) && activeStates.has(s) ? "muted" : stateTone(s),
      })),
      caution: feed?._tag === "Saved" || reconnecting,
    },
    notes: visibleNotes,
    moreNotes,
    groups,
    selected: state.selected,
    footer: {
      compact: state.rows < 24,
      status: footerStatus,
      caution: footerCaution,
      attentionOnly: state.attentionOnly,
    },
    overlay: state.help,
    offset,
    detail,
    act: actView(state),
    animating:
      !state.help &&
      (state.detail
        ? detailAnimating(state, detail)
        : feed === null ||
          (reconnecting && state.rows >= 24) ||
          animatedLines.some((line) => line >= offset && line < offset + available)),
  };
}

function currentDetail(state: State): Detail | null {
  const feed = state.detail?.feed;
  if (!feed || feed._tag === "Archived") return null;
  return feed._tag === "Reconnecting" ? feed.last : feed.detail;
}
export function detailLayout(detail: DetailView, columns: number, rows: number) {
  const height = Math.max(1, rows - 2 - detail.message.length);
  const headerHeight =
    (columns < 80 ? detail.header.length : Math.ceil(detail.header.length / 2)) +
    2 +
    detail.warnings.length;
  let position = headerHeight;
  let start = 0;
  let end = 0;
  for (const pane of detail.panes) {
    if (columns >= 120 && pane.id === "feed") continue;
    if (pane.focused) {
      start = position;
      end = position + pane.height;
    }
    position += pane.height;
  }
  return { headerHeight, offset: end > height ? Math.min(start, end - height) : 0, height };
}
function detailAnimating(state: State, detail: DetailView | null): boolean {
  if (!detail || detail.status === "archived") return false;
  if (unsupervised(state.detail?.feed)) return false;
  if (detail.status === "loading" || detail.status === "reconnecting") return true;
  const { offset, headerHeight, height } = detailLayout(detail, state.columns, state.rows);
  const visible = (position: number) => position >= offset && position < offset + height;
  if (detail.state && ["running", "starting", "waiting"].includes(detail.state) && visible(0))
    return true;
  let position = headerHeight;
  for (const pane of detail.panes) {
    if (state.columns >= 120 && pane.id === "feed") continue;
    if (
      pane.lines
        .slice(pane.offset, pane.offset + pane.height - 2)
        .some((line, index) => line.kind === "working" && visible(position + 1 + index))
    )
      return true;
    position += pane.height;
  }
  return false;
}
const textLines = (text: string, tone: Tone = "fg"): DetailLine[] =>
  text.split(/\r?\n/).map((text) => ({ text: cleanText(text), tone }));
function feedLines(events: readonly RunEvent[], data: Detail): DetailLine[] {
  return events.flatMap(({ at, event }): DetailLine[] => {
    const timestamp = clockTime(at);
    const line = (text: string, tone: Tone = "muted", symbol?: string): DetailLine[] => [
      { text: oneLine(text), tone, at: timestamp, ...(symbol === undefined ? {} : { symbol }) },
    ];
    switch (event._tag) {
      case "Command": {
        const open =
          event.exitCode === null && !["completed", "failed", "declined"].includes(event.status);
        const failed =
          ["failed", "declined"].includes(event.status) ||
          (event.exitCode !== null && event.exitCode !== 0);
        const command = shellCommand(event.command);
        if (open) return line(command, "running", "…");
        if (failed) return line(command, "failed", `×${event.exitCode ?? ""}`);
        return line(command, "done", "✓");
      }
      case "FileChange":
        return event.paths.flatMap((path) => line(`write ${path}`, "fg"));
      case "AgentMessage":
        return line(firstProseLine(event.text), "fg");
      case "QuestionAsked":
      case "HookBlocked": {
        const pending =
          event._tag === "QuestionAsked" &&
          data.questions.some((q) => q.id === event.id && q.status === "pending");
        let tone: Tone = pending ? "signal" : "muted";
        if (event._tag === "HookBlocked") tone = "failed";
        const title =
          event._tag === "QuestionAsked" ? `■ ${event.kind} ${event.id}` : "■ hooks blocked";
        const text =
          event._tag === "QuestionAsked" ? event.question : `${event.event}: ${event.feedback}`;
        return [
          { text: title, tone, at: timestamp, frame: "top" },
          { text: oneLine(text), tone: "fg", frame: "body" },
          { text: "", tone: "line", frame: "bottom" },
        ];
      }
      case "StateChanged":
        return line(`${event.from} → ${event.to}`);
      case "TurnStarted":
        return line(`turn ${event.turn} ${event.kind}`);
      case "TurnCompleted":
        return line(
          `turn ${event.turn} ${event.status}${event.failure ? `: ${event.failure.message}` : ""}`,
        );
      case "QuestionResolved":
        return line(`${event.id} ${event.resolution}`);
      case "Resumed":
        return line(`resumed ${event.model} · ${event.sandbox}`);
      case "Interrupted":
        return line(`interrupted by ${event.by}`);
      case "Retrying":
        return line(`retrying: ${event.message}`);
      case "McpStartupFailed":
        return line(`MCP ${event.server}: ${event.error ?? "startup failed"}`);
      case "Steered":
        return line(`steer: ${event.message}`);
      case "TokenUsage":
      case "Other":
        return [];
    }
    return [];
  });
}
const questionTones = {
  pending: "signal",
  deferred: "interrupted",
  resolved: "muted",
  cancelled: "muted",
} as const;
function detailView(state: State): DetailView | null {
  const detail = state.detail;
  if (!detail) return null;
  const data = currentDetail(state);
  const base = {
    name: detail.name,
    stale: false,
    focus: detail.focus,
    header: [],
    warnings: [],
    panes: [],
  };
  if (detail.feed?._tag === "Archived")
    return {
      ...base,
      state: null,
      tone: "muted",
      status: "archived",
      message: [
        "Run no longer available",
        "It may have been archived. Press Esc to return to the list.",
        `foreman status ${detail.name}`,
      ],
    };
  if (!data)
    return {
      ...base,
      state: null,
      tone: "muted",
      status: detail.feed?._tag === "Reconnecting" ? "reconnecting" : "loading",
      message: [
        detail.feed?._tag === "Reconnecting" ? "Reconnecting to daemon" : "Opening run detail",
        "Press Esc to return to the list.",
        `foreman status ${detail.name}`,
      ],
    };
  const { run, record, digest } = data;
  const stale = unsupervised(detail.feed) && activeStates.has(run.state);
  // The worktree fields stay null until a turn ends or status refreshes them.
  const files = [
    digest.filesWritten && `${digest.filesWritten.length} written`,
    digest.outsideMayChange && `${digest.outsideMayChange.length} outside May change`,
    digest.newInGitStatus && `${digest.newInGitStatus.length} new in git status`,
  ].filter((part) => part !== null);
  const tokens = digest.tokens;
  const digestLines = [
    `commands  ${digest.commands.total} total · ${digest.commands.failed} failed · ${digest.commands.blockedByHooks} hooks blocked`,
    `last command  ${digest.commands.last ? shellCommand(digest.commands.last.command) : "none"}${digest.commands.last?.exitCode === null || !digest.commands.last ? "" : ` · exit ${digest.commands.last.exitCode}`}`,
    `files  ${files.length > 0 ? files.join(" · ") : "counted when the turn ends"}`,
    `tokens  ${tokenCount(tokens?.input ?? 0)} input · ${tokenCount(tokens?.cachedInput ?? 0)} cached (${!tokens?.input ? 0 : Math.round((100 * tokens.cachedInput) / tokens.input)}% hit)`,
    `        ${tokenCount(tokens?.output ?? 0)} output · ${tokenCount(tokens?.reasoningOutput ?? 0)} reasoning`,
    ...(digest.failure ? [`failure  ${digest.failure.message}`] : []),
  ];
  const commands = [
    ...(run.group === state.group
      ? [
          ...data.questions
            .filter((q) => q.status === "pending")
            .map((q) => `foreman answer ${run.name} ${q.id} --file <path>`),
          ...(activeStates.has(run.state) ? [`foreman interrupt ${run.name}`] : []),
        ]
      : ["other repo: its own session supervises it"]),
    `foreman result ${run.name}`,
    `foreman events ${run.name} --follow`,
  ];
  const entries: Record<PaneId, readonly DetailLine[]> = {
    task: textLines(data.contract || "No contract recorded."),
    digest: digestLines.map((text) => ({ text: oneLine(text), tone: "fg" })),
    questions: data.questions.length
      ? data.questions.flatMap((q) => [
          {
            text: `${q.id} · ${q.kind} · ${q.status} · ${age(q.askedAt, state.now)} ago${q.resolvedAt ? ` · resolved ${clockTime(q.resolvedAt)}` : ""}`,
            tone: questionTones[q.status],
          },
          ...textLines(q.text),
        ])
      : textLines("No questions.", "muted"),
    subagents: run.subagents.length
      ? run.subagents.flatMap((agent) => [
          {
            text: `${oneLine(agent.path)} · ${agent.state}${agent.model && agent.model !== run.model ? ` · ${oneLine(agent.model)}` : ""}${agent.effort && agent.effort !== run.effort ? ` · ${oneLine(agent.effort)}` : ""}`,
            tone: "fg" as const,
            kind:
              !unsupervised(detail.feed) && agent.state === "working"
                ? ("working" as const)
                : ("subagent-idle" as const),
          },
          {
            text: `started ${clockTime(agent.startedAt)} · ${plural(agent.interactions, "interaction")} · ${age(agent.lastInteractionAt, state.now)} ago`,
            tone: "muted" as const,
          },
        ])
      : textLines("No subagents recorded.", "muted"),
    handoff: textLines(data.handoff?.text ?? "No hand-off available."),
    commands: commands.map((text) => ({ text, tone: "fg" })),
    feed: [
      ...(detail.gap
        ? textLines("gap: earlier events are no longer available", "interrupted")
        : []),
      ...(detail.dropped
        ? textLines(`${detail.dropped} older events dropped from buffer`, "muted")
        : []),
      ...feedLines(detail.events, data),
    ],
  };
  if (state.columns < 80)
    entries.subagents = textLines(`${run.subagents.length} subagents`, "muted");
  const titles: Record<PaneId, string> = {
    task: "Task",
    digest: "Digest",
    questions: "Questions",
    subagents: "Subagents",
    handoff: "Hand-off",
    commands: "Commands",
    feed: "Feed",
  };
  const heights: Record<PaneId, number> = {
    task: 8,
    digest: 8,
    questions: 6,
    subagents: 6,
    handoff: 7,
    commands: 6,
    feed: state.rows >= 40 ? Math.max(34, state.rows - 2) : Math.max(6, state.rows - 2),
  };
  const panes = DETAIL_PANES.map((id): PaneView => {
    const noticeRows =
      detail.feed?._tag === "Saved" || detail.feed?._tag === "Reconnecting" ? 3 : 0;
    const height = Math.min(heights[id], Math.max(3, state.rows - 2 - noticeRows));
    const maximum = Math.max(0, entries[id].length - (height - 2));
    let value = "";
    if (id === "feed") value = detail.follow ? "following" : "paused · f to follow";
    else if (id === "task" && data.contractTruncated)
      value = `truncated at ${data.contractByteLimit} bytes`;
    else if (id === "handoff" && data.handoff) value = `turn ${data.handoff.turn}`;
    return {
      id,
      title: titles[id],
      lines: entries[id],
      height,
      focused: detail.focus === id,
      offset: id === "feed" && detail.follow ? maximum : Math.min(maximum, detail.offsets[id]),
      value,
    };
  });
  let connection = "live";
  let message: readonly string[] = [];
  if (detail.feed?._tag === "Saved") {
    connection = `saved · ${detail.feed.reason}`;
    message = [
      detail.feed.reason === "outdated"
        ? "Saved state · daemon is outdated"
        : "Saved state · daemon not running",
      "The monitor checks again automatically; start work in another terminal.",
      `foreman status ${detail.name}`,
    ];
  } else if (detail.feed?._tag === "Reconnecting") {
    connection = "reconnecting";
    message = [
      "Reconnecting to daemon",
      oneLine(detail.feed.reason),
      `foreman status ${detail.name}`,
    ];
  }
  return {
    name: run.name,
    stale,
    state: run.state,
    tone: stale ? "muted" : stateTone(run.state),
    status: detail.feed?._tag === "Reconnecting" ? "reconnecting" : "ready",
    message,
    focus: detail.focus,
    header: [
      ["worktree", record.worktree],
      ["branch", record.branch ?? "not recorded"],
      ["base", record.baseCommit.slice(0, 12)],
      ["--from", record.fromRef ?? "not recorded"],
      ["created", stamp(record.createdAt, state.now)],
      ["updated", stamp(record.updatedAt, state.now)],
      ["run dir", record.runDir],
      ["model", `${run.model} · ${run.effort} · ${run.tier}`],
      ["turn", `${run.turn} ${run.turnKind ?? ""}`],
      ["connection", connection],
    ].map(([label, value]) => [label ?? "", cleanText(value ?? "")] as const),
    warnings: run.warnings.map(oneLine),
    panes,
  };
}
