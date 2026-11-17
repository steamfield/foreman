import type { RunName } from "../../schemas/daemon";
import type { Message, State } from "./model";

/** Opens a fresh run detail with a uniquely identified change request. */
export function openDetail(
  name: RunName,
  id: number,
  review = false,
): NonNullable<State["detail"]> {
  return {
    name,
    feed: null,
    events: [],
    gap: false,
    dropped: 0,
    focus: "task",
    follow: true,
    offsets: {
      task: 0,
      digest: 0,
      questions: 0,
      subagents: 0,
      handoff: 0,
      commands: 0,
      files: 0,
      feed: 0,
    },
    changes: { id, files: null, error: null, selected: 0 },
    diff: null,
    feedFilter: "all",
    feedSearch: { text: "", editing: false },
    review,
    reviewFocus: "handoff",
  };
}

/** Starts a change-list refresh without accepting replies from a previous request. */
export function refreshChanges(state: State): State {
  if (!state.detail) return state;
  return {
    ...state,
    nextInspectId: state.nextInspectId + 1,
    detail: {
      ...state.detail,
      diff: null,
      reviewFocus: state.detail.reviewFocus === "diff" ? "files" : state.detail.reviewFocus,
      changes: { id: state.nextInspectId, files: null, error: null, selected: 0 },
    },
  };
}

/** Requests a selected file's diff, retaining the detail's opening pane. */
export function openFileDiff(state: State, selected = state.detail?.changes?.selected ?? 0): State {
  const detail = state.detail;
  const file = detail?.changes?.files?.[selected];
  if (!detail?.changes || !file) return state;
  return {
    ...state,
    nextInspectId: state.nextInspectId + 1,
    detail: {
      ...detail,
      changes: { ...detail.changes, selected },
      diff: { id: state.nextInspectId, path: file.path, text: null, error: null, offset: 0 },
    },
  };
}

/** Applies inspection replies only while their original request remains open. */
export function inspectResult(state: State, msg: Message): State | null {
  const detail = state.detail;
  if (msg.type === "changes-result") {
    if (!detail?.changes || detail.changes.id !== msg.id) return state;
    return {
      ...state,
      detail: {
        ...detail,
        changes: { ...detail.changes, files: msg.files, error: msg.error, selected: 0 },
      },
    };
  }
  if (msg.type === "diff-result") {
    if (!detail?.diff || detail.diff.id !== msg.id) return state;
    return {
      ...state,
      detail: { ...detail, diff: { ...detail.diff, text: msg.text, error: msg.error } },
    };
  }
  if (msg.type === "pager-result") {
    if (state.pager?.id !== msg.id) return state;
    return {
      ...state,
      pager: null,
      act:
        msg.error === null
          ? state.act
          : { ...state.act, notice: { ok: false, text: msg.error, at: state.now } },
    };
  }
  return null;
}
