import { DateTime } from "effect";
import { activeStates, type RunEvent } from "../../schemas/daemon";
import type { Detail } from "../../schemas/monitor";
import { clockTime } from "./format";
import type { State, TimelineView, Tone } from "./model-types";

type Cell = TimelineView["cells"][number];
const cell = (glyph: string, tone: Tone): Cell => ({ glyph, tone });

/** Draws event and subagent activity across the run's lifetime at the current width. */
export function timelineView(state: State, data: Detail | null): TimelineView | null {
  if (!state.detail || !data || state.columns < 40 || state.detail.review) return null;
  const events = state.detail.events;
  const start = DateTime.toEpochMillis(data.record.createdAt);
  const end = Math.max(
    start,
    activeStates.has(data.run.state)
      ? state.now
      : DateTime.toEpochMillis(events.at(-1)?.at ?? data.record.updatedAt),
  );
  const step = Math.max(1, end - start) / state.columns;
  const first = events.find((e) => e.event._tag === "StateChanged")?.event;
  let running =
    first?._tag === "StateChanged" ? first.from === "running" : data.run.state === "running";
  let cursor = 0;
  const cells = Array.from({ length: state.columns }, (_, index) => {
    const slice: RunEvent[] = [];
    const boundary = index === state.columns - 1 ? end + 1 : start + (index + 1) * step;
    let worked = running;
    while (cursor < events.length) {
      const entry = events[cursor];
      if (!entry || DateTime.toEpochMillis(entry.at) >= boundary) break;
      slice.push(entry);
      cursor++;
      if (entry.event._tag === "StateChanged") running = entry.event.to === "running";
      if (entry.event._tag === "TurnStarted") running = true;
      if (entry.event._tag === "TurnCompleted" || entry.event._tag === "Interrupted")
        running = false;
      worked ||= running;
    }
    return sliceCell(slice, worked);
  });
  return {
    label: "Timeline",
    cells,
    subagentCells: subagents(data, start, step, state.columns, end),
    ticks: ticks(start, end, state.columns),
    legend: "━ working  × failed command  ┄ quiet  ■ question",
  };
}

function sliceCell(events: readonly RunEvent[], running: boolean): Cell {
  if (events.some((e) => e.event._tag === "QuestionAsked")) return cell("■", "signal");
  if (
    events.some(
      (e) =>
        e.event._tag === "Command" &&
        (["failed", "declined"].includes(e.event.status) ||
          (e.event.exitCode !== null && e.event.exitCode !== 0)),
    )
  )
    return cell("×", "failed");
  if (events.length > 0) return cell("━", "running");
  return running ? cell("┄", "muted") : cell(" ", "muted");
}

function subagents(
  data: Detail,
  start: number,
  step: number,
  width: number,
  end: number,
): TimelineView["subagentCells"] {
  if (!data.run.subagents.length) return null;
  return Array.from({ length: width }, (_, index) => {
    const from = start + index * step;
    const to = from + step;
    return data.run.subagents.some(
      (agent) =>
        DateTime.toEpochMillis(agent.startedAt) < to &&
        (agent.state === "working" ? end : DateTime.toEpochMillis(agent.lastInteractionAt)) >= from,
    )
      ? cell("━", "running")
      : cell(" ", "muted");
  });
}

function ticks(start: number, end: number, width: number): string {
  const cells = Array.from({ length: width }, () => " ");
  for (let i = 0; i <= 5; i++) {
    const text = clockTime(DateTime.makeUnsafe(start + ((end - start) * i) / 5)).slice(0, 5);
    const offset = Math.min(width - text.length, Math.round(((width - 1) * i) / 5));
    for (const [index, character] of [...text].entries()) cells[offset + index] = character;
  }
  return cells.join("");
}
