import type { RunName } from "../../schemas/daemon";
import { initialAct, reduceAct } from "./act";
import { actView } from "./act-view";
import { feedSearchInput } from "./detail-filter";
import { detailFeed, detailKey } from "./detail-reducer";
import { currentDetail, detailAnimating, detailView } from "./detail-view";
import { diffView } from "./diff";
import { findHelpKeys, reduceFind } from "./find";
import { historyView } from "./history";
import { inspectKey } from "./inspect-input";
import { inspectResult, openDetail } from "./inspect-state";
import { listGroups } from "./list-groups";
import { listKey, repairSelection } from "./list-input";
import { listView } from "./list-view";
import type { Message, State, ViewModel } from "./model-types";
import { paletteView } from "./palette";
import { previewFeed, syncPreview } from "./preview";
import { reviewView } from "./review";
import { timelineView } from "./timeline";

/** Creates the monitor's initial list or direct-detail state. */
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
  preview: null,
  filter: { text: "", editing: false },
  palette: null,
  grouping: "repo",
  history: null,
  nextHistoryId: 1,
  clipboard: null,
  pager: null,
  nextInspectId: options.name === undefined ? 1 : 2,
  detail: options.name === undefined ? null : openDetail(options.name, 1),
});

/** Reduces monitor input and keeps the selected list preview in sync. */
export function reduce(state: State, msg: Message): State {
  const next = repairSelection(state, reduceState(state, msg), msg);
  const selected = listGroups(next)
    .flatMap((group) => group.runs)
    .find((run) => run.name === next.selected);
  return syncPreview(next, selected);
}

function reduceState(state: State, msg: Message): State {
  if (msg.type === "key" && state.act.notice !== null)
    state = { ...state, act: { ...state.act, notice: null } };
  // Earlier handlers own shared keys before list and detail navigation.
  const handlers = [
    inspectResult,
    feedSearchInput,
    inspectionInput,
    reduceFind,
    previewInput,
    actingInput,
    detailFeed,
    frameInput,
    helpInput,
    detailInput,
    listInput,
  ];
  for (const handler of handlers) {
    const next = handler(state, msg);
    if (typeof next === "string")
      return reduceState({ ...state, palette: null }, { type: "key", key: next });
    if (next !== null) return next;
  }
  return state;
}

function inspectionInput(state: State, msg: Message): State | null {
  return msg.type === "key" ? inspectKey(state, msg.key) : null;
}

function previewInput(state: State, msg: Message): State | null {
  if (msg.type !== "preview-feed") return null;
  if (!state.preview || state.preview.name !== msg.name) return state;
  return {
    ...state,
    now: msg.value._tag === "Reconnecting" ? state.now : Math.max(state.now, msg.value.receivedAt),
    preview: previewFeed(state.preview, msg.value),
  };
}

function actingInput(state: State, msg: Message): State | null {
  return msg.type === "key" ||
    msg.type === "draft" ||
    msg.type === "act-outcome" ||
    msg.type === "editor-result" ||
    msg.type === "acting-lost"
    ? reduceAct(state, msg)
    : null;
}

function frameInput(state: State, msg: Message): State | null {
  if (msg.type === "tick")
    return Math.floor(state.now / 1000) === Math.floor(msg.now / 1000)
      ? state
      : { ...state, now: msg.now };
  if (msg.type === "feed")
    return {
      ...state,
      feed: msg.value,
      now:
        msg.value._tag === "Reconnecting" ? state.now : Math.max(state.now, msg.value.receivedAt),
    };
  if (msg.type === "resize")
    return { ...state, columns: Math.max(1, msg.columns), rows: Math.max(3, msg.rows) };
  return null;
}

function helpInput(state: State, msg: Message): State | null {
  if (msg.type !== "key") return null;
  if (msg.key === "?" || (state.help && msg.key === "escape"))
    return { ...state, help: !state.help };
  return state.help ? state : null;
}

function detailInput(state: State, msg: Message): State | null {
  return msg.type === "key" ? detailKey(state, msg.key) : null;
}

function listInput(state: State, msg: Message): State | null {
  return msg.type === "key" ? listKey(state, msg.key) : null;
}

/** Assembles the list and inspection views without routing input. */
export function view(state: State, previous?: ViewModel): ViewModel {
  const detail = detailView(state);
  const data = currentDetail(state);
  const { model: list } = listView(state, previous);
  return {
    ...list,
    detail,
    act: actView(state),
    palette: paletteView(state),
    history: historyView(state),
    grouping: state.grouping,
    timeline: timelineView(state, data),
    diff: diffView(state),
    review: reviewView(state, data),
    feedTabs: state.detail
      ? {
          filter: state.detail.feedFilter,
          search: state.detail.feedSearch.text,
          editing: state.detail.feedSearch.editing,
        }
      : null,
    helpKeys: findHelpKeys,
    animating: !state.help && (state.detail ? detailAnimating(state, detail) : list.animating),
  };
}
