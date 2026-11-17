import { unsupervised } from "./format";
import type { State, ViewModel } from "./model-types";

/** Computes row boundaries, automatic scrolling and animated positions. */
export function listPosition(
  state: State,
  model: Pick<
    ViewModel,
    "message" | "notes" | "moreNotes" | "pinned" | "morePinned" | "listColumns" | "groups"
  >,
  available: number,
) {
  const noteHeight = state.columns < 100 ? 3 : 4;
  let position =
    model.message.length +
    model.notes.length * noteHeight +
    (model.moreNotes > 0 ? 1 : 0) +
    (state.columns < 100 ? Number(model.pinned.length > 0) : model.pinned.length) +
    Number(model.morePinned > 0);
  const spans: { start: number; end: number; id: string }[] = [];
  const animatedLines: number[] = unsupervised(state.feed)
    ? []
    : model.notes.map((_, index) => model.message.length + index * noteHeight);
  const boundaries = [0];
  for (const group of model.groups) {
    boundaries.push(++position);
    if (Object.values(model.listColumns).some(Boolean)) boundaries.push(++position);
    for (const entry of group.rows) {
      const start = position;
      position += 2 + (state.columns < 100 ? 0 : entry.subagents.length);
      spans.push({ start, end: position, id: entry.name });
      if (!entry.stale && ["running", "starting", "waiting"].includes(entry.state))
        animatedLines.push(start);
      if (state.columns >= 100)
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

  return { offset, animatedLines };
}
