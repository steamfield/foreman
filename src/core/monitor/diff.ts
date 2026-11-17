import type { DiffText } from "../runs/changes";
import { openFileDiff } from "./inspect-state";
import { type DiffView, type ReviewView, type State, view } from "./model";

/** Computes review pane dimensions for rendering and diff navigation. */
export function reviewLayout(review: ReviewView, width: number, height: number) {
  const handoffHeight = Math.min(
    (review.handoff?.lines.length ?? 1) + 2,
    Math.max(3, Math.floor(height / 4)),
  );
  const decisionHeight = Math.min(
    Math.max(1, review.decided.length * 3) + 2,
    Math.max(3, Math.floor(height / 4)),
  );
  const remaining = Math.max(6, height - 1 - handoffHeight - decisionHeight);
  const stacked = width < 120;
  const fileHeight = stacked
    ? Math.min(remaining - 3, Math.max(1, review.files.length) + 3)
    : remaining;
  return {
    handoffHeight,
    decisionHeight,
    remaining,
    stacked,
    fileHeight,
    fileWidth: stacked ? width : Math.floor(width * 0.32),
    diffHeight: stacked ? remaining - fileHeight : remaining,
  };
}

/** Parses unified diff lines while tracking each side's hunk line numbers. */
export function parseDiff(diff: DiffText): DiffView["lines"] {
  let old = 0;
  let next = 0;
  let inHunk = false;
  const source = diff.text.split(/\r?\n/);
  if (source.at(-1) === "") source.pop();
  const lines = source.map((raw): DiffView["lines"][number] => {
    const text = raw.replace(/[^\P{Cc}\t]/gu, " ");
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      return { text, kind: "hunk", oldLine: null, newLine: null };
    }
    if (text.startsWith("diff ")) inHunk = false;
    if (inHunk && text.startsWith("+"))
      return { text, kind: "add", oldLine: null, newLine: next++ };
    if (inHunk && text.startsWith("-"))
      return { text, kind: "remove", oldLine: old++, newLine: null };
    if (inHunk && text.startsWith(" "))
      return { text, kind: "context", oldLine: old++, newLine: next++ };
    return { text, kind: "meta", oldLine: null, newLine: null };
  });
  if (diff.truncated)
    lines.push({
      text: `… diff cut at ${new TextEncoder().encode(diff.text).length} bytes; D opens the whole diff in $PAGER`,
      kind: "meta",
      oldLine: null,
      newLine: null,
    });
  return lines;
}

/** Builds a loading, failed or parsed diff view for the active request. */
export function diffView(state: State): DiffView | null {
  const diff = state.detail?.diff;
  if (!diff) return null;
  const files = state.detail?.changes?.files ?? [];
  const index = files.findIndex((file) => file.path === diff.path);
  const lines = diff.text ? parseDiff(diff.text) : [];
  const hunks = lines.flatMap((line, index) => (line.kind === "hunk" ? [index] : []));
  const offset = Math.min(diff.offset, Math.max(0, lines.length - 1));
  const hunk =
    hunks.length === 0 ? 0 : Math.max(1, hunks.filter((index) => index <= offset).length);
  let status: DiffView["status"] = diff.text === null ? "loading" : "ready";
  if (diff.error !== null) status = "failed";
  return {
    title:
      diff.path === null
        ? "all files"
        : `${diff.path.replace(/\p{Cc}/gu, " ")} · ${index + 1} of ${files.length}`,
    position: `hunk ${hunk} of ${hunks.length}`,
    status,
    message: diff.error ?? (diff.text === null ? "loading diff…" : null),
    lines,
    offset,
    truncated: diff.text?.truncated ?? false,
  };
}

/** Handles navigation while the diff owns the terminal's keys. */
export function diffKey(state: State, key: string): State {
  const detail = state.detail;
  const diff = detail?.diff;
  if (!detail || !diff) return state;
  if (key === "escape")
    return {
      ...state,
      detail: { ...detail, diff: null, reviewFocus: detail.review ? "files" : detail.reviewFocus },
    };
  if (key === "]" || key === "[") {
    const files = detail.changes?.files ?? [];
    const index = files.findIndex((file) => file.path === diff.path);
    const next = index + (key === "]" ? 1 : -1);
    return index < 0 || next < 0 || next >= files.length ? state : openFileDiff(state, next);
  }
  const model = diffView(state);
  if (!model) return state;
  const page = key.startsWith("page-") ? diffPage(state, model) : 1;
  const offset = navigate(model, page, key);
  return { ...state, detail: { ...detail, diff: { ...diff, offset } } };
}

function diffPage(state: State, diff: DiffView): number {
  const model = view(state);
  const height = Math.max(
    1,
    model.rows -
      2 -
      Number(model.act.notice !== null) -
      Number(model.filterBar !== null && !model.overlay),
  );
  const viewport = model.review
    ? reviewLayout(model.review, model.columns, height).diffHeight
    : height;
  return Math.max(1, viewport - 2 - Number(diff.truncated));
}

function navigate(model: DiffView, page: number, key: string): number {
  const maximum = Math.max(0, model.lines.length - 1);
  if (key === "home") return 0;
  if (key === "end") return maximum;
  if (key === "n" || key === "p") {
    const hunks = model.lines.flatMap((line, index) => (line.kind === "hunk" ? [index] : []));
    return key === "n"
      ? (hunks.find((index) => index > model.offset) ?? model.offset)
      : (hunks.filter((index) => index < model.offset).at(-1) ?? model.offset);
  }
  const moves: Readonly<Record<string, number>> = {
    j: 1,
    down: 1,
    k: -1,
    up: -1,
    "page-down": page,
    "page-up": -page,
  };
  return Math.max(0, Math.min(maximum, model.offset + (moves[key] ?? 0)));
}
