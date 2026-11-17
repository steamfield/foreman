import { needsMeFilter, toggleNeedsMe } from "./filter";
import { historyKey, historyResult } from "./history";
import { listGroups, nextGrouping } from "./list-groups";
import type { Message, State } from "./model";
import { paletteKey } from "./palette";

/** The find commands available to the help overlay. */
export const findHelpKeys = [
  { key: "/", label: "filter" },
  { key: ":", label: "command palette" },
  { key: "g", label: "group repo / state / recent" },
  { key: "h", label: "history" },
  { key: "!", label: "toggle needs:me filter" },
];

/** Routes find inputs before list and acting shortcuts, leaving acting overlays in control. */
export function reduceFind(state: State, msg: Message): State | string | null {
  if (msg.type === "history-result") return historyResult(state, msg);
  if (msg.type === "filter-text")
    return state.filter.editing ? setFilter(state, msg.text, true) : state;
  if (msg.type === "palette-query")
    return state.palette ? { ...state, palette: { query: msg.text, index: 0 } } : state;
  if (msg.type !== "key" || state.act.overlay || state.act.editor) return null;
  if (state.filter.editing) return filterKey(state, msg.key);
  if (state.palette) return paletteKey(state, msg.key);
  if (state.help || state.detail) return null;
  if (msg.key === "/") return { ...state, filter: { ...state.filter, editing: true } };
  if (state.history) return msg.key === "?" ? null : historyKey(state, msg.key);
  if (msg.key === ":") return { ...state, palette: { query: "", index: 0 } };
  if (msg.key === "g") return { ...state, grouping: nextGrouping(state.grouping), scroll: null };
  if (msg.key === "h")
    return {
      ...state,
      history: { id: state.nextHistoryId, entries: null, error: null, selected: 0, skipped: 0 },
      nextHistoryId: state.nextHistoryId + 1,
    };
  if (msg.key === "!") return setFilter(state, toggleNeedsMe(state.filter.text), false);
  return null;
}

function filterKey(state: State, key: string): State {
  if (key === "escape") return setFilter(state, "", false);
  if (key === "enter") return setFilter(state, state.filter.text, false);
  if (key === "backspace")
    return setFilter(state, [...state.filter.text].slice(0, -1).join(""), true);
  if ([...key].length === 1 && !/\p{Cc}/u.test(key))
    return setFilter(state, state.filter.text + key, true);
  return state;
}

function setFilter(state: State, text: string, editing: boolean): State {
  const next = {
    ...state,
    filter: { text, editing },
    attentionOnly: needsMeFilter(text),
    scroll: null,
    history: state.history ? { ...state.history, selected: 0 } : null,
  };
  if (next.history) return next;
  const groups = listGroups(next);
  const runs = groups.flatMap((group) => group.runs);
  if (
    runs.some((run) => run.name === next.selected) ||
    groups.some((group) => group.runs.length > 0 && next.selected === `older:${group.id}`)
  )
    return next;
  return { ...next, selected: runs[0]?.name ?? null };
}
