import { DateTime } from "effect";
import type { RunEvent } from "../../schemas/daemon";
import type { Detail, RunView } from "../../schemas/monitor";
import type { DetailFeed } from "./detail-feed";
import { duration } from "./format";
import type { PreviewView, RowView, State } from "./model-types";

const clean = (text: string) => text.replace(/\p{Cc}/gu, " ");
const oneLine = (text: string) => clean(text.split(/\r?\n/, 1)[0] ?? "");
const data = (feed: DetailFeed | null): Detail | null => {
  if (!feed || feed._tag === "Archived") return null;
  return feed._tag === "Reconnecting" ? feed.last : feed.detail;
};
const commentary = (feed: DetailFeed | null): RunEvent | undefined => {
  if (feed?._tag !== "Live" && feed?._tag !== "Saved") return undefined;
  return feed.events.findLast(
    (entry) => entry.event._tag === "AgentMessage" && entry.event.phase === "commentary",
  );
};

/** Tracks the selected list run and discards a previous selection's detail feed. */
export function syncPreview(state: State, selected: RunView | undefined): State {
  const name = state.detail === null ? (selected?.name ?? null) : null;
  if (name === null) return state.preview === null ? state : { ...state, preview: null };
  return state.preview?.name === name
    ? state
    : { ...state, preview: { name, feed: null, commentary: null } };
}

/** Stores each preview feed and retains the latest commentary across empty pages and reconnects. */
export function previewFeed(
  previous: NonNullable<State["preview"]>,
  incoming: DetailFeed,
): NonNullable<State["preview"]> {
  const before = data(previous.feed);
  const after = data(incoming);
  const replaced =
    before &&
    after &&
    DateTime.toEpochMillis(before.record.createdAt) !==
      DateTime.toEpochMillis(after.record.createdAt);
  const retained = incoming._tag === "Archived" || replaced ? null : previous.commentary;
  return { name: previous.name, feed: incoming, commentary: commentary(incoming) ?? retained };
}

function prose(contract: string | undefined): string | null {
  if (!contract) return null;
  const lines = contract.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  let fenced: string | null = null;
  for (const line of lines.slice(heading + 1)) {
    const fence = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (fenced === null) fenced = fence;
      else if (fence[0] === fenced[0] && fence.length >= fenced.length && line === fence)
        fenced = null;
      continue;
    }
    if (fenced !== null || line === "" || /^#{1,6}\s/.test(line) || /^(?:[-*_]\s*){3,}$/.test(line))
      continue;
    return clean(line);
  }
  return null;
}

/** Presents contract prose, activity, commentary and changed files for the selected list run. */
export function previewView(state: State, row: RowView | undefined): PreviewView | null {
  if (state.detail || state.rows < 30 || !row || state.preview?.name !== row.name) return null;
  const feed = state.preview.feed;
  const detail = data(feed);
  const paths = detail?.digest.filesWritten ?? [];
  const outside = detail?.digest.outsideMayChange;
  const said = state.preview.commentary;
  let lastSaid: string | null = null;
  if (said?.event._tag === "AgentMessage")
    lastSaid = `“${oneLine(said.event.text)}” · ${duration(state.now - DateTime.toEpochMillis(said.at))} ago`;
  return {
    name: row.name,
    task: prose(detail?.contract) ?? row.task,
    now:
      row.activity === ""
        ? null
        : row.activity + (row.activityAge === null ? "" : ` · ${row.activityAge}`),
    said: lastSaid,
    files: paths
      .slice(0, 3)
      .map((path) => ({ path: clean(path), outside: outside?.includes(path) ?? false })),
    moreFiles: Math.max(0, paths.length - 3),
    outsideCount: detail ? (outside?.length ?? null) : selectedOutside(state, row.name),
  };
}

function selectedOutside(state: State, name: string): number | null {
  const feed = state.feed;
  const overview = feed?._tag === "Reconnecting" ? feed.last : feed?.overview;
  return overview?.runs.find((run) => run.name === name)?.outsideMayChange ?? null;
}
