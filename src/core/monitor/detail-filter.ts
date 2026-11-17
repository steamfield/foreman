import type { RunEvent } from "../../schemas/daemon";
import type { FeedFilter, Message, State } from "./model-types";

const tags: Readonly<Record<FeedFilter, readonly RunEvent["event"]["_tag"][]>> = {
  all: [],
  commands: ["Command"],
  files: ["FileChange"],
  messages: ["AgentMessage"],
  questions: ["QuestionAsked", "QuestionResolved", "HookBlocked"],
};

/** Selects event categories before converting them to feed display lines. */
export function filteredEvents(
  events: readonly RunEvent[],
  filter: FeedFilter,
): readonly RunEvent[] {
  return filter === "all"
    ? events
    : events.filter((entry) => tags[filter].includes(entry.event._tag));
}

/** Handles detail feed search while its text input owns the keys. */
export function feedSearchInput(state: State, msg: Message): State | null {
  const detail = state.detail;
  if (!detail || state.act.overlay || state.act.editor || state.help) return null;
  if (msg.type === "feed-search-text")
    return detail.feedSearch.editing ? search(state, msg.text, true) : state;
  if (msg.type !== "key") return null;
  if (detail.feedSearch.editing) {
    if (msg.key === "escape") return search(state, "", false);
    if (msg.key === "enter") return search(state, detail.feedSearch.text, false);
    return state;
  }
  if (detail.diff || detail.review) return null;
  if (msg.key === "/") return search(state, detail.feedSearch.text, true);
  const filters: Readonly<Record<string, FeedFilter>> = {
    "1": "all",
    "2": "commands",
    "3": "files",
    "4": "messages",
    "5": "questions",
  };
  const filter = filters[msg.key];
  return filter
    ? {
        ...state,
        detail: { ...detail, feedFilter: filter, offsets: { ...detail.offsets, feed: 0 } },
      }
    : null;
}

function search(state: State, text: string, editing: boolean): State {
  if (!state.detail) return state;
  return {
    ...state,
    detail: {
      ...state.detail,
      feedSearch: { text, editing },
      offsets: { ...state.detail.offsets, feed: 0 },
    },
  };
}
