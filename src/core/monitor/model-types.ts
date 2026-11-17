import type { RunEvent, RunName } from "../../schemas/daemon";
import type { HistoryEntry, RunView } from "../../schemas/monitor";
import type { ChangedFile, DiffText } from "../runs/changes";
import type { ActMessage, ActState, ActView } from "./act";
import type { DetailFeed } from "./detail-feed";
import type { MonitorFeed } from "./feed";

/** Maximum number of retained detail journal events. */
export const EVENT_BUFFER_LIMIT = 1000;
/** The ordered detail pane cycle. */
export const DETAIL_PANES = [
  "task",
  "digest",
  "questions",
  "subagents",
  "handoff",
  "commands",
  "files",
  "feed",
] as const;
/** Identifies a pane in the detail focus cycle. */
export type PaneId = (typeof DETAIL_PANES)[number];
/** Feed filters on the detail Feed title, keys 1 to 5. */
export type FeedFilter = "all" | "commands" | "files" | "messages" | "questions";
/** The detail timeline strip: one row of cells across the run's life. */
export type TimelineView = {
  readonly label: string;
  readonly cells: readonly { readonly glyph: string; readonly tone: Tone }[];
  readonly subagentCells: readonly { readonly glyph: string; readonly tone: Tone }[] | null;
  readonly ticks: string;
  readonly legend: string;
};
/** The full-screen diff view. */
export type DiffView = {
  readonly title: string;
  readonly position: string;
  readonly status: "loading" | "ready" | "failed";
  readonly message: string | null;
  readonly lines: readonly {
    readonly text: string;
    readonly kind: "hunk" | "add" | "remove" | "context" | "meta";
    readonly oldLine: number | null;
    readonly newLine: number | null;
  }[];
  readonly offset: number;
  readonly truncated: boolean;
};
/** The review screen for a finished run. */
export type ReviewView = {
  /** The review pane selected by Tab. */
  readonly focus: "handoff" | "decided" | "files" | "diff";
  /** Loading, failure or empty-list text for the shared Files pane. */
  readonly filesMessage: string | null;
  /** Explains how a late answer resumes a finished run. */
  readonly lateAnswerHint: string;
  readonly summary: string;
  readonly reviewed: boolean;
  readonly handoff: { readonly title: string; readonly lines: readonly string[] } | null;
  readonly decided: readonly {
    readonly question: string;
    readonly asked: string;
    readonly outcome: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly status: string;
    readonly added: string;
    readonly removed: string;
    readonly outside: boolean;
    readonly selected: boolean;
  }[];
  readonly filesNote: string;
};
/** A terminal-safe detail line with optional event decoration. */
export type DetailLine = {
  /** True for the Files pane's currently selected path. */
  readonly selected?: boolean;
  readonly text: string;
  readonly tone: Tone;
  readonly kind?: "working" | "subagent-idle";
  readonly at?: string;
  readonly symbol?: string;
  readonly frame?: "top" | "body" | "bottom";
};
/** A framed detail pane with its focus and scroll position. */
export type PaneView = {
  readonly id: PaneId;
  readonly title: string;
  readonly value: string;
  readonly lines: readonly DetailLine[];
  readonly height: number;
  readonly offset: number;
  readonly focused: boolean;
};
/** The inspected run snapshot and its rendered panes. */
export type DetailView = {
  readonly name: string;
  readonly stale: boolean;
  readonly state: RunView["state"] | null;
  readonly tone: Tone;
  readonly status: "loading" | "ready" | "archived" | "reconnecting";
  readonly message: readonly string[];
  readonly header: readonly (readonly [string, string])[];
  readonly warnings: readonly string[];
  readonly panes: readonly PaneView[];
  readonly focus: PaneId;
};
/** Semantic colors used by monitor renderers. */
export type Tone =
  | "fg"
  | "muted"
  | "line"
  | "signal"
  | "running"
  | "done"
  | "failed"
  | "interrupted";
/** Execution defaults used to mark per-run overrides. */
export type Defaults = Pick<RunView, "model" | "effort" | "tier">;
/** A short row annotation with its semantic tone. */
export type FlagView = { readonly text: string; readonly tone: Tone };
/** The list row facts and optional progress indicators. */
export type RowView = {
  /** Finished work's review prompt, including the emphasized action key. */
  readonly review: {
    readonly text: string;
    readonly key: "r" | null;
    readonly bold: boolean;
    readonly tone: Tone;
  } | null;
  readonly name: string;
  readonly stale: boolean;
  readonly state: RunView["state"];
  readonly turn: number;
  readonly turnKind: RunView["turnKind"];
  readonly activityAge: string | null;
  readonly tone: Tone;
  readonly age: string;
  readonly activity: string;
  readonly activityTone: Tone;
  readonly flags: readonly FlagView[];
  readonly budget: { readonly filled: number; readonly label: string; readonly tone: Tone } | null;
  readonly subagents: readonly { path: string; working: boolean; text: string }[];
  /** The contract's first heading, else null. */
  readonly task: string | null;
  /** Model and effort, short form such as `sol · high`. */
  readonly modelLabel: string;
  /** Turn, commands and failures such as `t2 · 14 cmds`; failures are counted separately. */
  readonly progress: { readonly text: string; readonly failed: number } | null;
  /** Sparkline cells for the pace column, or null when the run has no pace data. */
  readonly pace: string | null;
};
/** Which optional list columns fit at the current width, in spec 15.7 drop order. */
export type ListColumns = {
  readonly task: boolean;
  readonly model: boolean;
  readonly progress: boolean;
  readonly pace: boolean;
  readonly budgetLabel: boolean;
};
/** A one-line attention row pinned above the groups for a non-question reason. */
export type PinnedRowView = {
  readonly kind: "failed" | "budget" | "quiet";
  readonly name: string;
  readonly text: string;
  /** The attention reason without detail or action hints at narrow widths. */
  readonly compactText?: string;
  readonly tone: Tone;
  readonly keys: readonly { readonly key: string; readonly label: string }[];
};
/** The selected run's preview strip at the bottom of the list. */
export type PreviewView = {
  readonly name: string;
  readonly task: string | null;
  readonly now: string | null;
  readonly said: string | null;
  readonly files: readonly { readonly path: string; readonly outside: boolean }[];
  readonly moreFiles: number;
  readonly outsideCount: number | null;
};
/** The filter bar under the header while `/` is editing or a filter is applied. */
export type FilterBarView = {
  readonly text: string;
  readonly editing: boolean;
  readonly shown: number;
  readonly total: number;
  /** Waiting runs the filter hides, so a question is never invisible. */
  readonly hiddenWaiting: number;
};
/** The `:` command palette. */
export type PaletteView = {
  readonly query: string;
  readonly subject: string | null;
  readonly items: readonly {
    readonly label: string;
    readonly detail: string;
    readonly key: string | null;
    readonly selected: boolean;
    readonly heading: boolean;
  }[];
};
/** The history screen opened with `h`. */
export type HistoryView = {
  readonly status: "loading" | "ready" | "failed";
  readonly message: string | null;
  readonly rows: readonly {
    readonly name: string;
    readonly repo: string;
    readonly task: string | null;
    readonly outcome: string;
    readonly tone: Tone;
    readonly ended: string;
    readonly duration: string;
    readonly turns: number;
    readonly tokens: string;
    readonly archived: boolean;
  }[];
  readonly selected: number;
  readonly offset: number;
};
/** A titled run group with an optional collapsed older section. */
export type GroupView = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly rows: readonly RowView[];
  readonly older: { readonly id: string; readonly text: string } | null;
};
/** The complete monitor frame consumed by the TUI. */
export type ViewModel = {
  readonly columns: number;
  readonly rows: number;
  readonly now: number;
  readonly layout: "narrow" | "medium" | "wide";
  readonly budgetCells: number;
  readonly screen: "probing" | "list" | "empty" | "saved" | "outdated" | "reconnecting";
  readonly message: readonly string[];
  /** True only when no live or saved runs exist and onboarding is appropriate. */
  readonly firstRun: boolean;
  readonly header: {
    version: string;
    daemon: string;
    defaults: string;
    counts: readonly { state: string; count: number; tone: Tone }[];
    caution: boolean;
  };
  readonly notes: readonly { id: string; title: string; text: string; command: string }[];
  readonly moreNotes: number;
  readonly groups: readonly GroupView[];
  readonly selected: string | null;
  readonly footer: { compact: boolean; status: string; caution: boolean; attentionOnly: boolean };
  readonly overlay: boolean;
  readonly animating: boolean;
  readonly offset: number;
  readonly detail: DetailView | null;
  readonly act: ActView;
  readonly listColumns: ListColumns;
  readonly timeline: TimelineView | null;
  readonly diff: DiffView | null;
  readonly review: ReviewView | null;
  readonly feedTabs: {
    readonly filter: FeedFilter;
    readonly search: string;
    readonly editing: boolean;
  } | null;
  readonly pinned: readonly PinnedRowView[];
  /** Number of attention rows hidden by the three-row cap. */
  readonly morePinned: number;
  readonly preview: PreviewView | null;
  readonly filterBar: FilterBarView | null;
  readonly palette: PaletteView | null;
  readonly history: HistoryView | null;
  readonly grouping: "repo" | "state" | "recent";
  /** Find commands for the help overlay. */
  readonly helpKeys: readonly { readonly key: string; readonly label: string }[];
};
/** The monitor state retained between messages. */
export type State = {
  readonly group: string;
  readonly defaults: Defaults;
  readonly version: string;
  readonly now: number;
  readonly columns: number;
  readonly rows: number;
  readonly feed: MonitorFeed | null;
  readonly selected: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly attentionOnly: boolean;
  readonly help: boolean;
  readonly scroll: number | null;
  readonly detail: {
    readonly name: RunName;
    readonly feed: DetailFeed | null;
    readonly events: readonly RunEvent[];
    readonly gap: boolean;
    readonly dropped: number;
    readonly focus: PaneId;
    readonly offsets: Readonly<Record<PaneId, number>>;
    readonly follow: boolean;
    /** The worktree change list, requested on demand; `id` pairs it with `changes-result`. */
    readonly changes: {
      readonly id: number;
      readonly files: readonly ChangedFile[] | null;
      readonly error: string | null;
      readonly selected: number;
    } | null;
    /** The diff view, open over the detail or review screen. */
    readonly diff: {
      readonly id: number;
      readonly path: string | null;
      readonly text: DiffText | null;
      readonly error: string | null;
      readonly offset: number;
    } | null;
    readonly feedFilter: FeedFilter;
    readonly feedSearch: { readonly text: string; readonly editing: boolean };
    /** True when the run opened in the review screen instead of plain detail. */
    readonly review: boolean;
    /** Review has its own pane cycle, separate from the detail panes. */
    readonly reviewFocus: ReviewView["focus"];
  } | null;
  /** A pending `$PAGER` hand-off for the whole diff; the executor replies with `pager-result`. */
  readonly pager: { readonly id: number; readonly name: RunName } | null;
  readonly nextInspectId: number;
  readonly act: ActState;
  /** The `/` filter text and whether its input is open. */
  readonly filter: { readonly text: string; readonly editing: boolean };
  /** The `:` palette query and highlighted item, or null when closed. */
  readonly palette: { readonly query: string; readonly index: number } | null;
  readonly grouping: "repo" | "state" | "recent";
  /** The history screen, its request id while loading, and its rows once read. */
  readonly history: {
    readonly id: number;
    readonly entries: readonly HistoryEntry[] | null;
    readonly skipped: number;
    readonly error: string | null;
    readonly selected: number;
  } | null;
  readonly nextHistoryId: number;
  /** A uniquely numbered clipboard request for the terminal executor. */
  readonly clipboard: { readonly id: number; readonly text: string } | null;
  /** The selected run's detail feed while the list is showing, for the preview strip. */
  readonly preview: {
    readonly name: RunName;
    readonly feed: DetailFeed | null;
    readonly commentary: RunEvent | null;
  } | null;
};
/** Inputs and asynchronous results consumed by the monitor reducer. */
export type Message =
  | { readonly type: "feed"; readonly value: MonitorFeed }
  | { readonly type: "detail-feed"; readonly name: RunName; readonly value: DetailFeed }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "resize"; readonly columns: number; readonly rows: number }
  | ActMessage
  | { readonly type: "preview-feed"; readonly name: RunName; readonly value: DetailFeed }
  | { readonly type: "filter-text"; readonly text: string }
  | { readonly type: "palette-query"; readonly text: string }
  | { readonly type: "feed-search-text"; readonly text: string }
  | {
      readonly type: "changes-result";
      readonly id: number;
      readonly files: readonly ChangedFile[] | null;
      readonly error: string | null;
    }
  | {
      readonly type: "diff-result";
      readonly id: number;
      readonly text: DiffText | null;
      readonly error: string | null;
    }
  | { readonly type: "pager-result"; readonly id: number; readonly error: string | null }
  | {
      readonly type: "history-result";
      readonly id: number;
      readonly entries: readonly HistoryEntry[] | null;
      readonly skipped: number;
      readonly error: string | null;
    };
