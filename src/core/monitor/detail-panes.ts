import type { Detail } from "../../schemas/monitor";
import {
  DETAIL_PANES,
  type DetailLine,
  type PaneId,
  type PaneView,
  type State,
} from "./model-types";

/** Sizes detail panes and clamps each pane's selected or scrolled lines. */
export function detailPanes(
  state: State,
  data: Detail,
  entries: Record<PaneId, readonly DetailLine[]>,
): PaneView[] {
  const detail = state.detail;
  if (!detail) return [];
  const titles: Record<PaneId, string> = {
    task: "Task",
    digest: "Digest",
    questions: "Questions",
    subagents: "Subagents",
    handoff: "Hand-off",
    commands: "Commands",
    files: `Files · ${detail.changes?.files?.length ?? 0} changed`,
    feed: `Feed · ${detail.feedFilter}`,
  };
  const heights: Record<PaneId, number> = {
    task: 8,
    digest: 8,
    questions: 6,
    subagents: 6,
    handoff: 7,
    commands: 6,
    files: 8,
    feed: state.rows >= 40 ? Math.max(34, state.rows - 2) : Math.max(6, state.rows - 2),
  };
  return DETAIL_PANES.map((id): PaneView => {
    const noticeRows =
      detail.feed?._tag === "Saved" || detail.feed?._tag === "Reconnecting" ? 3 : 0;
    const height = Math.min(heights[id], Math.max(3, state.rows - 2 - noticeRows));
    const maximum = Math.max(0, entries[id].length - (height - 2));
    let value = "";
    if (id === "feed") value = detail.follow ? "following" : "paused · f to follow";
    else if (id === "task" && data.contractTruncated)
      value = `truncated at ${data.contractByteLimit} bytes`;
    else if (id === "handoff" && data.handoff) value = `turn ${data.handoff.turn}`;
    let offset = id === "feed" && detail.follow ? maximum : Math.min(maximum, detail.offsets[id]);
    if (id === "files") {
      const selected = detail.changes?.selected ?? 0;
      offset = Math.min(maximum, Math.max(0, selected - (height - 3)));
    }
    return {
      id,
      title: titles[id],
      lines: entries[id],
      height,
      focused: detail.focus === id,
      offset,
      value,
    };
  });
}
