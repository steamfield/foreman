import { listNotes } from "./attention";
import { filterBar } from "./filter";
import { unsupervised } from "./format";
import { listColumns } from "./list-columns";
import { groupViews } from "./list-groups";
import { listPosition } from "./list-layout";
import { listFooter, listStatus } from "./list-status";
import type { State, ViewModel } from "./model-types";
import { pinnedRows } from "./pinned";
import { previewView } from "./preview";

const PREVIEW_ROWS = 5;
/** Computes the drawn body and list heights after fixed rows are reserved. */
export function listViewport(
  rows: number,
  visible: {
    readonly notice: boolean;
    readonly filter: boolean;
    readonly hiddenWaiting: boolean;
    readonly preview: boolean;
  },
) {
  const available = Math.max(1, rows - 2 - Number(visible.notice) - Number(visible.filter));
  return {
    available,
    height: Math.max(
      0,
      available - Number(visible.hiddenWaiting) - (visible.preview ? PREVIEW_ROWS : 0),
    ),
  };
}

/** Builds list rows, status and the visible list position. */
export function listView(state: State, previous?: ViewModel) {
  const feed = state.feed;
  const model = listContent(state, previous);
  const viewport = listViewport(state.rows, {
    notice: state.act.notice !== null,
    filter: model.filterBar !== null && !state.help,
    hiddenWaiting:
      !state.detail && !state.history && !state.help && (model.filterBar?.hiddenWaiting ?? 0) > 0,
    preview: !state.detail && !state.history && !state.help && model.preview !== null,
  });
  const position = listPosition(state, model, viewport.height);
  return {
    viewport,
    model: {
      ...model,
      offset: position.offset,
      animating:
        !state.help &&
        (feed === null ||
          (feed?._tag === "Saved" && model.firstRun) ||
          (feed?._tag === "Reconnecting" && state.rows >= 24) ||
          position.animatedLines.some(
            (line) => line >= position.offset && line < position.offset + viewport.height,
          )),
    },
  };
}

function listContent(state: State, previous?: ViewModel) {
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  const runs = overview?.runs ?? [];
  const { layout, budgetCells } = listSize(state.columns);
  const groups = groupViews(state, budgetCells, previous);
  const status = listStatus(state, runs, groups.length);
  const notes = listNotes(state);
  const limit = state.rows < 24 ? 1 : 3;
  const preview = previewView(
    state,
    groups.flatMap((group) => group.rows).find((row) => row.name === state.selected),
  );
  return {
    columns: state.columns,
    rows: state.rows,
    now: state.now,
    layout,
    budgetCells,
    ...status,
    groups,
    notes: notes.slice(0, limit),
    moreNotes: Math.max(0, notes.length - limit),
    ...pinnedRows(runs, state.now, !unsupervised(feed)),
    preview,
    filterBar: filterBar(state, runs),
    listColumns: listColumns(state.columns),
    selected: state.selected,
    overlay: state.help,
    footer: listFooter(state),
  };
}

function listSize(columns: number) {
  let layout: ViewModel["layout"] = "narrow";
  let budgetCells = 0;
  if (columns >= 120) {
    layout = "wide";
    budgetCells = 10;
  } else if (columns >= 80) {
    layout = "medium";
    budgetCells = 6;
  }
  return { layout, budgetCells };
}
