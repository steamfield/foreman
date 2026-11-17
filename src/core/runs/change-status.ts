import type { ChangedFile } from "./changes";

/** Extracts untracked paths from NUL-delimited porcelain status. */
export const untrackedPaths = (status: string): readonly string[] => {
  const fields = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry.startsWith("?? ")) paths.push(entry.slice(3));
    else if (/^[RC]|^.[RC]/.test(entry)) i++;
  }
  return paths;
};

/** Reads NUL-delimited numstat counts keyed by the destination path. */
export const parseCounts = (text: string) => {
  const counts = new Map<string, Pick<ChangedFile, "added" | "removed">>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry === "") continue;
    const first = entry.indexOf("\t");
    const second = entry.indexOf("\t", first + 1);
    let path = entry.slice(second + 1);
    if (path === "") {
      path = fields[i + 2] ?? "";
      i += 2;
    }
    const added = entry.slice(0, first);
    const removed = entry.slice(first + 1, second);
    counts.set(path, {
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }
  return counts;
};

/** Reads NUL-delimited name-status entries keyed by the destination path. */
export const parseStatuses = (text: string) => {
  const statuses = new Map<string, ChangedFile["status"]>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length - 1; i += 2) {
    const status = fields[i] ?? "";
    const renamed = status.startsWith("R");
    const path = fields[i + (renamed ? 2 : 1)] ?? "";
    if (renamed) i++;
    let kind: ChangedFile["status"] = "modified";
    if (status === "A") kind = "added";
    else if (status === "D") kind = "deleted";
    else if (renamed) kind = "renamed";
    statuses.set(path, kind);
  }
  return statuses;
};
