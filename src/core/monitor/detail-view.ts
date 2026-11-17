import { activeStates, type RunEvent } from "../../schemas/daemon";
import type { Detail } from "../../schemas/monitor";
import { firstProseLine } from "./attention";
import { changedLines } from "./changed-files";
import {
  commandLine,
  detailCommands,
  detailConnection,
  detailHeader,
  digestFacts,
  questionFrame,
  subagentLines,
} from "./detail-facts";
import { filteredEvents } from "./detail-filter";
import { detailPanes } from "./detail-panes";
import { age, cleanText, clockTime, oneLine, stateTone, unsupervised } from "./format";
import type { DetailLine, DetailView, PaneId, State, Tone } from "./model-types";

/** Reads the latest available detail snapshot. */
export function currentDetail(state: State): Detail | null {
  const feed = state.detail?.feed;
  if (!feed || feed._tag === "Archived") return null;
  return feed._tag === "Reconnecting" ? feed.last : feed.detail;
}
/** Computes the visible detail body and focused pane offset. */
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
/** Reports whether a visible detail line needs animation. */
export function detailAnimating(state: State, detail: DetailView | null): boolean {
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
/** Splits multiline detail text into safe terminal lines. */
export const textLines = (text: string, tone: Tone = "fg"): DetailLine[] =>
  text.split(/\r?\n/).map((text) => ({ text: cleanText(text), tone }));
/** Converts journal events to the feed lines shared by detail and answer context. */
export function feedLines(events: readonly RunEvent[], data: Detail): DetailLine[] {
  return events.flatMap(({ at, event }): DetailLine[] => {
    const timestamp = clockTime(at);
    const line = (text: string, tone: Tone = "muted", symbol?: string): DetailLine[] => [
      { text: oneLine(text), tone, at: timestamp, ...(symbol === undefined ? {} : { symbol }) },
    ];
    switch (event._tag) {
      case "Command": {
        const command = commandLine(event);
        return line(command.text, command.tone, command.symbol);
      }
      case "FileChange":
        return event.paths.flatMap((path) => line(`write ${path}`, "fg"));
      case "AgentMessage":
        return line(firstProseLine(event.text), "fg");
      case "QuestionAsked":
      case "HookBlocked":
        return questionFrame(event, data, timestamp);
      default: {
        const text = eventText(event);
        return text === null ? [] : line(text);
      }
    }
  });
}
const questionTones = {
  pending: "signal",
  deferred: "interrupted",
  resolved: "muted",
  cancelled: "muted",
} as const;

/** Formats a question resolution and its source. */
export function questionResolution(
  event: Extract<RunEvent["event"], { _tag: "QuestionResolved" }>,
): string {
  return `${event.id} ${event.resolution}${event.source === "monitor" ? " from monitor" : ""}`;
}
/** Builds the active run detail panes and metadata. */
export function detailView(state: State): DetailView | null {
  const detail = state.detail;
  if (!detail) return null;
  const data = currentDetail(state);
  if (detail.feed?._tag === "Archived" || !data) return unavailableDetail(detail);
  const { run } = data;
  const stale = unsupervised(detail.feed) && activeStates.has(run.state);
  const entries = detailEntries(state, data, detail);
  const panes = detailPanes(state, data, entries);
  const { connection, message } = detailConnection(detail);
  return {
    name: run.name,
    stale,
    state: run.state,
    tone: stale ? "muted" : stateTone(run.state),
    status: detail.feed?._tag === "Reconnecting" ? "reconnecting" : "ready",
    message,
    focus: detail.focus,
    header: detailHeader(state, data, connection),
    warnings: run.warnings.map(oneLine),
    panes,
  };
}

function detailEntries(
  state: State,
  data: Detail,
  detail: NonNullable<State["detail"]>,
): Record<PaneId, readonly DetailLine[]> {
  const run = data.run;
  const entries: Record<PaneId, readonly DetailLine[]> = {
    task: textLines(data.contract || "No contract recorded."),
    digest: digestFacts(data).map((text) => ({ text: oneLine(text), tone: "fg" })),
    questions: questionLines(state, data, detail),
    subagents:
      state.columns < 80
        ? textLines(`${run.subagents.length} subagents`, "muted")
        : subagentLines(run, detail.feed, state.now),
    handoff: textLines(data.handoff?.text ?? "No hand-off available."),
    commands: detailCommands(state, data).map((text) => ({ text, tone: "fg" })),
    files: changedLines(detail.changes),
    feed: [
      ...(detail.gap
        ? textLines("gap: earlier events are no longer available", "interrupted")
        : []),
      ...(detail.dropped
        ? textLines(`${detail.dropped} older events dropped from buffer`, "muted")
        : []),
      ...feedLines(filteredEvents(detail.events, detail.feedFilter), data),
    ].filter((line) =>
      line.text.toLocaleLowerCase().includes(detail.feedSearch.text.toLocaleLowerCase()),
    ),
  };
  return entries;
}

function questionLines(
  state: State,
  data: Detail,
  detail: NonNullable<State["detail"]>,
): DetailLine[] {
  return data.questions.length
    ? data.questions.flatMap((q) => [
        {
          text: `${q.id} · ${q.kind} · ${q.status} · ${age(q.askedAt, state.now)} ago${q.resolvedAt ? ` · resolved ${clockTime(q.resolvedAt)}` : ""}`,
          tone: questionTones[q.status],
        },
        ...textLines(q.text),
        ...detail.events
          .flatMap(({ event }): DetailLine[] =>
            event._tag === "QuestionResolved" && event.id === q.id && event.source === "monitor"
              ? [{ text: questionResolution(event), tone: "muted" }]
              : [],
          )
          .slice(-1),
      ])
    : textLines("No questions.", "muted");
}

function eventText(event: RunEvent["event"]): string | null {
  switch (event._tag) {
    case "StateChanged":
      return `${event.from} → ${event.to}`;
    case "TurnStarted":
      return `turn ${event.turn} ${event.kind}`;
    case "TurnCompleted":
      return `turn ${event.turn} ${event.status}${event.failure ? `: ${event.failure.message}` : ""}`;
    case "QuestionResolved":
      return questionResolution(event);
    case "Resumed":
      return `resumed ${event.model} · ${event.sandbox}`;
    case "Interrupted":
      return event.by === "monitor" ? "interrupted from monitor" : `interrupted by ${event.by}`;
    case "Retrying":
      return `retrying: ${event.message}`;
    case "McpStartupFailed":
      return `MCP ${event.server}: ${event.error ?? "startup failed"}`;
    case "Steered":
      return `steer: ${event.message}`;
    case "TokenUsage":
    case "Other":
      return null;
    default:
      return null;
  }
}

function unavailableDetail(detail: NonNullable<State["detail"]>): DetailView {
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
}
