/**
 * Reads a run's code change from its worktree for the monitor: the changed files with line
 * counts, and unified diff text. Read-only git commands with --no-optional-locks; never
 * touches the index or refs. Runs on demand, never on a timer.
 */
import type { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { WorktreeInvalid } from "../../errors";

/** One changed path against the run's base commit, including untracked files. */
export type ChangedFile = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Null for binary files. */
  readonly added: number | null;
  readonly removed: number | null;
  /** True when the path falls outside the contract's May change list. */
  readonly outside: boolean;
};

/** Diff text, cut at `maxBytes` with `truncated` set. */
export type DiffText = { readonly text: string; readonly truncated: boolean };

/**
 * Lists the worktree's changes against `baseCommit`, sorted by path.
 *
 * @throws {WorktreeInvalid} When git fails in the worktree.
 */
export const readChanges = (
  _worktree: string,
  _baseCommit: string,
  _contract: string,
): Effect.Effect<
  readonly ChangedFile[],
  WorktreeInvalid,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  throw new Error("not implemented");
};

/**
 * Reads the unified diff against `baseCommit` for one path, or all paths when `path` is null.
 *
 * @throws {WorktreeInvalid} When git fails in the worktree.
 */
export const readDiff = (
  _worktree: string,
  _baseCommit: string,
  _path: string | null,
  _maxBytes: number,
): Effect.Effect<DiffText, WorktreeInvalid, ChildProcessSpawner.ChildProcessSpawner> => {
  throw new Error("not implemented");
};
