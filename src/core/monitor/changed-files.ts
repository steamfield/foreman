import type { ChangedFile } from "../runs/changes";
import type { DetailLine, ReviewView, State } from "./model-types";

const statuses = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "?" } as const;

/** Converts change records to the file rows shared by detail and review. */
export function changedRows(changes: NonNullable<State["detail"]>["changes"]): ReviewView["files"] {
  return (changes?.files ?? []).map((file, index) => ({
    path: file.path.replace(/\p{Cc}/gu, " "),
    status: statuses[file.status],
    added: stat(file.added, "+", file.status),
    removed: stat(file.removed, "−", file.status),
    outside: file.outside,
    selected: changes?.selected === index,
  }));
}

function stat(value: ChangedFile["added"], sign: string, status: ChangedFile["status"]): string {
  if (value !== null) return `${sign}${value}`;
  return status === "untracked" ? "?" : "binary";
}

/** Reports a pending or failed change read without disguising it as an empty result. */
export function changesMessage(changes: NonNullable<State["detail"]>["changes"]): string | null {
  if (changes?.error !== null && changes?.error !== undefined) return changes.error;
  if (!changes?.files) return "loading changes…";
  return changes.files.length === 0 ? "No changes." : null;
}

/** Builds the Files pane's numstat lines and outside-scope marks. */
export function changedLines(
  changes: NonNullable<State["detail"]>["changes"],
): readonly DetailLine[] {
  const message = changesMessage(changes);
  if (message !== null) return [{ text: message, tone: changes?.error ? "failed" : "muted" }];
  return changedRows(changes).map((file) => ({
    text: `${file.status} ${file.path}  ${file.added} ${file.removed}${file.outside ? "  ▲ outside May change" : ""}`,
    tone: file.outside ? "interrupted" : "fg",
    selected: file.selected,
  }));
}
