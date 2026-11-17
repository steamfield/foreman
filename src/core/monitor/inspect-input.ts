import { selectedRun } from "./act-target";
import { diffKey } from "./diff";
import { openDetail, openFileDiff, refreshChanges } from "./inspect-state";
import type { State } from "./model-types";

/** Routes inspection shortcuts before the acting commands that share their keys. */
export function inspectKey(state: State, key: string): State | null {
  if (
    state.act.overlay ||
    state.act.editor ||
    state.help ||
    state.filter.editing ||
    state.palette ||
    state.history
  )
    return null;
  const detail = state.detail;
  if (key === "r" && !detail?.review) return openReview(state);
  if (!detail) return null;
  if (key === "D")
    return state.pager
      ? state
      : {
          ...state,
          pager: { id: state.nextInspectId, name: detail.name },
          nextInspectId: state.nextInspectId + 1,
        };
  if (key === "R") return refreshChanges(state);
  if (detail.review && (key === "tab" || key === "\t")) return reviewTab(state);
  if (detail.review && ["a", "r", "F", "x"].includes(key)) return null;
  if (detail.diff) return diffKey(state, key);
  const filesFocused = detail.review ? detail.reviewFocus === "files" : detail.focus === "files";
  return filesFocused ? filesKey(state, key) : null;
}

function openReview(state: State): State {
  const run = selectedRun(state);
  if (!run || !["idle", "failed", "interrupted"].includes(run.state)) return state;
  const detail = state.detail;
  const opened = detail
    ? { ...detail, review: true, reviewFocus: "handoff" as const }
    : openDetail(run.name, state.nextInspectId, true);
  return detail
    ? refreshChanges({ ...state, detail: opened })
    : { ...state, detail: opened, nextInspectId: state.nextInspectId + 1 };
}

function filesKey(state: State, key: string): State | null {
  if (key === "d") return openFileDiff(state);
  if (!["j", "down", "k", "up"].includes(key)) return null;
  const detail = state.detail;
  if (!detail?.changes) return state;
  const selected = Math.max(
    0,
    Math.min(
      (detail.changes.files?.length ?? 1) - 1,
      detail.changes.selected + (["j", "down"].includes(key) ? 1 : -1),
    ),
  );
  return { ...state, detail: { ...detail, changes: { ...detail.changes, selected } } };
}

function reviewTab(state: State): State {
  const detail = state.detail;
  if (!detail) return state;
  const panes = ["handoff", "decided", "files", "diff"] as const;
  const focus = panes[(panes.indexOf(detail.reviewFocus) + 1) % panes.length] ?? "handoff";
  const next = { ...state, detail: { ...detail, reviewFocus: focus, diff: null } };
  return focus === "diff" ? openFileDiff(next) : next;
}
