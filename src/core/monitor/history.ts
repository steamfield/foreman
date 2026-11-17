import { DateTime } from "effect";
import { tokenCount } from "../runs/digest";
import { matchesFilter } from "./filter";
import { duration, stateTone } from "./format";
import type { HistoryView, Message, State } from "./model-types";

const clean = (text: string) => text.replace(/\p{Cc}/gu, " ");
const entries = (state: State) =>
  (state.history?.entries ?? []).filter((entry) => matchesFilter(entry, state.filter.text, true));

/** Applies only the current history request's result, preserving a read failure. */
export function historyResult(
  state: State,
  msg: Extract<Message, { type: "history-result" }>,
): State {
  if (!state.history || state.history.id !== msg.id) return state;
  const next = { ...state, history: { ...state.history, entries: msg.entries, error: msg.error } };
  return {
    ...next,
    history: {
      ...next.history,
      selected: Math.max(0, Math.min(next.history.selected, entries(next).length - 1)),
    },
  };
}

/** Navigates history without dispatching actions against the underlying list. */
export function historyKey(state: State, key: string): State {
  const history = state.history;
  if (!history) return state;
  if (key === "escape" || key === "h") return { ...state, history: null };
  let selected = history.selected;
  if (key === "home") selected = 0;
  else if (key === "end") selected = entries(state).length - 1;
  else if (["j", "down"].includes(key)) selected++;
  else if (["k", "up"].includes(key)) selected--;
  else return state;
  return {
    ...state,
    history: { ...history, selected: Math.max(0, Math.min(entries(state).length - 1, selected)) },
  };
}

/** Presents finished runs with honest unknown times and explicit loading or failure status. */
export function historyView(state: State): HistoryView | null {
  const history = state.history;
  if (!history) return null;
  const rows = entries(state).map((entry) => {
    const endedAt = entry.endedAt === null ? null : DateTime.toEpochMillis(entry.endedAt);
    return {
      name: entry.name,
      repo: clean(entry.repo),
      task: entry.title === null ? null : clean(entry.title),
      outcome: entry.state === "idle" ? "done" : entry.state,
      tone: stateTone(entry.state),
      ended: endedAt === null ? "—" : `${duration(state.now - endedAt)} ago`,
      duration:
        endedAt === null ? "—" : duration(endedAt - DateTime.toEpochMillis(entry.createdAt)),
      turns: entry.turns,
      tokens: tokenCount(entry.tokensTotal),
      archived: entry.archived,
    };
  });
  let status: HistoryView["status"] = "ready";
  let message: string | null = rows.length === 0 ? "No finished runs yet." : null;
  if (history.error !== null) {
    status = "failed";
    message = `Could not read run history: ${clean(history.error)}`;
  } else if (history.entries === null) {
    status = "loading";
    message = "Reading run history…";
  }
  const selected = Math.max(0, Math.min(history.selected, rows.length - 1));
  const height = Math.max(
    1,
    state.rows - 4 - Number(state.filter.editing || !!state.filter.text.trim()),
  );
  return { status, message, rows, selected, offset: Math.max(0, selected - height + 1) };
}
