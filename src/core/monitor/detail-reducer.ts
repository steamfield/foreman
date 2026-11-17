import { DateTime } from "effect";
import type { Detail } from "../../schemas/monitor";
import type { DetailFeed } from "./detail-feed";
import { filteredEvents } from "./detail-filter";
import { currentDetail, detailView, feedLines } from "./detail-view";
import { openDetail } from "./inspect-state";
import { DETAIL_PANES, EVENT_BUFFER_LIMIT, type Message, type State } from "./model-types";

const epoch = DateTime.toEpochMillis;
/** Merges detail journal updates without losing paused feed positions. */
export function detailFeed(state: State, msg: Message): State | null {
  if (msg.type !== "detail-feed") return null;
  if (!state.detail || state.detail.name !== msg.name) return state;
  state = resetDetail(state, msg.value);
  const detail = state.detail;
  if (!detail || detail.name !== msg.name) return state;
  const data = currentDetail(state);
  const incoming = msg.value._tag === "Live" || msg.value._tag === "Saved" ? msg.value.events : [];
  const lastSeq = detail.events.at(-1)?.seq ?? 0;
  const appended = [...detail.events, ...incoming.filter((entry) => entry.seq > lastSeq)];
  const dropped = Math.max(0, appended.length - EVENT_BUFFER_LIMIT);
  const gap =
    detail.gap || ((msg.value._tag === "Live" || msg.value._tag === "Saved") && msg.value.gap);
  const feedOffset = bufferedOffset(detail, data, dropped, gap);
  return {
    ...state,
    now: msg.value._tag === "Reconnecting" ? state.now : Math.max(state.now, msg.value.receivedAt),
    detail: {
      ...detail,
      feed: msg.value,
      events: appended.slice(-EVENT_BUFFER_LIMIT),
      dropped: detail.dropped + dropped,
      gap,
      offsets: {
        ...detail.offsets,
        feed: feedOffset,
      },
    },
  };
}

/** Handles pane focus, following and scroll keys in run detail. */
export function detailKey(state: State, key: string): State | null {
  if (!state.detail) return null;
  const detail = state.detail;
  if (key === "escape") return { ...state, detail: null };
  if (key === "tab" || key === "\t")
    return {
      ...state,
      detail: {
        ...detail,
        focus:
          DETAIL_PANES[(DETAIL_PANES.indexOf(detail.focus) + 1) % DETAIL_PANES.length] ?? "task",
      },
    };
  if (key === "f") {
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
  return scrollDetail(state, detail, key);
}

function scrollDetail(state: State, detail: NonNullable<State["detail"]>, key: string): State {
  const pane = detailView(state)?.panes.find((entry) => entry.id === detail.focus);
  if (!pane) return state;
  const page = Math.max(1, pane.height - 2);
  const maximum = Math.max(0, pane.lines.length - page);
  let offset = pane.offset;
  if (key === "home") offset = 0;
  else if (key === "end") offset = maximum;
  else if (["j", "down", "k", "up", "page-up", "page-down"].includes(key)) {
    const up = ["k", "up", "page-up"].includes(key);
    offset += (up ? -1 : 1) * (key.startsWith("page-") ? page : 1);
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

function bufferedOffset(
  detail: NonNullable<State["detail"]>,
  data: Detail | null,
  dropped: number,
  gap: boolean,
): number {
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(detail.feedSearch.text.toLocaleLowerCase());
  const removedLines = data
    ? feedLines(filteredEvents(detail.events.slice(0, dropped), detail.feedFilter), data).filter(
        (line) => matches(line.text),
      ).length
    : 0;
  const gapMarker = "gap: earlier events are no longer available";
  const droppedMarker = (count: number) =>
    count > 0 && matches(`${count} older events dropped from buffer`);
  const addedMarkers =
    Number(gap && matches(gapMarker)) -
    Number(detail.gap && matches(gapMarker)) +
    Number(droppedMarker(detail.dropped + dropped)) -
    Number(droppedMarker(detail.dropped));
  return Math.max(0, detail.offsets.feed - removedLines + addedMarkers);
}

function resetDetail(state: State, feed: DetailFeed): State {
  const detail = state.detail;
  if (!detail) return state;
  const data = currentDetail(state);
  let incomingDetail: Detail | null = null;
  if (feed._tag === "Live" || feed._tag === "Saved") incomingDetail = feed.detail;
  else if (feed._tag === "Reconnecting") incomingDetail = feed.last;
  if (
    feed._tag === "Archived" ||
    (data &&
      incomingDetail &&
      epoch(data.record.createdAt) !== epoch(incomingDetail.record.createdAt))
  ) {
    return {
      ...state,
      nextInspectId: state.nextInspectId + 1,
      detail: {
        ...openDetail(detail.name, state.nextInspectId, detail.review),
        focus: detail.focus,
        follow: detail.follow,
      },
    };
  }
  return state;
}
