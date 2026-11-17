import { openDetail } from "./inspect-state";
import { grouped, isOlder, listGroups } from "./list-groups";
import { listView } from "./list-view";
import type { Message, State } from "./model-types";

function selectable(state: State) {
  return listGroups(state).flatMap(({ id, runs }) => [
    ...runs
      .filter((run) => !isOlder(run, state.now) || state.expanded.has(id))
      .map((run) => run.name),
    ...(runs.some((run) => isOlder(run, state.now)) && !state.expanded.has(id)
      ? [`older:${id}`]
      : []),
  ]);
}

/** Handles selection, detail entry and paging in the run list. */
export function listKey(state: State, key: string): State | null {
  if (state.detail) return null;
  if (key === "page-up" || key === "page-down") {
    const { model, viewport } = listView(state);
    return {
      ...state,
      scroll: Math.max(
        0,
        model.offset + (key === "page-up" ? -1 : 1) * Math.max(1, viewport.height),
      ),
    };
  }
  if (key === "enter" && state.selected?.startsWith("older:"))
    return { ...state, expanded: new Set([...state.expanded, state.selected.slice(6)]) };
  else if (key === "enter" && state.selected) {
    const run = grouped(state)
      .flatMap((group) => group.runs)
      .find((run) => run.name === state.selected);
    return run
      ? {
          ...state,
          detail: openDetail(run.name, state.nextInspectId),
          nextInspectId: state.nextInspectId + 1,
        }
      : state;
  }
  return moveSelection(state, key);
}

function moveSelection(state: State, key: string): State {
  const keys = selectable(state);
  const index = Math.max(0, keys.indexOf(state.selected ?? ""));
  let target = index;
  if (["j", "down"].includes(key)) target = Math.min(keys.length - 1, index + 1);
  else if (["k", "up"].includes(key)) target = Math.max(0, index - 1);
  else if (key === "home") target = 0;
  else if (key === "end") target = keys.length - 1;
  else return state;
  return { ...state, selected: keys[target] ?? null, scroll: key === "home" ? 0 : null };
}

/** Repairs a list selection after feeds, filters or grouping change. */
export function repairSelection(state: State, next: State, msg: Message): State {
  const keys = selectable(next);
  const preservePosition =
    next !== state &&
    (msg.type === "feed" ||
      msg.type === "tick" ||
      msg.type === "resize" ||
      next.expanded !== state.expanded);
  if (!preservePosition) {
    if (
      next.history ||
      next.detail ||
      keys.includes(next.selected ?? "") ||
      (next.selected === null && keys.length === 0)
    )
      return next;
    return { ...next, selected: keys[0] ?? null, scroll: null };
  }
  const previousRun = grouped(state)
    .flatMap((group) => group.runs)
    .find((run) => run.name === state.selected);
  if (
    next.filter.text.trim() &&
    previousRun &&
    !listGroups(next).some((group) => group.runs.some((run) => run.name === previousRun.name))
  )
    return { ...next, selected: keys[0] ?? null, scroll: null };
  if (next.selected !== null && keys.includes(next.selected)) return next;
  const collapsed = grouped(next).find((group) =>
    group.runs.some((run) => run.name === next.selected),
  );
  if (collapsed && keys.includes(`older:${collapsed.id}`))
    return { ...next, selected: `older:${collapsed.id}`, scroll: null };
  const previousIndex = Math.max(0, selectable(state).indexOf(state.selected ?? ""));
  return { ...next, selected: keys[Math.min(previousIndex, keys.length - 1)] ?? null };
}
