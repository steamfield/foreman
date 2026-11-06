import { Effect } from "effect";
import { Usage } from "../errors";

interface StartMode {
  readonly newWorktree?: boolean;
  readonly worktree?: string | undefined;
  readonly from?: string | undefined;
  readonly setup?: string | undefined;
}

/** The daemon's managed-mode source directory is not a prepared worktree. */
export const validateStartMode = (input: StartMode) => {
  if (Boolean(input.newWorktree) === (input.worktree !== undefined))
    return Effect.fail(new Usage({ detail: "Choose either --worktree or --new-worktree." }));
  if (!input.newWorktree && input.from !== undefined)
    return Effect.fail(new Usage({ detail: "--from requires --new-worktree." }));
  if (!input.newWorktree && input.setup !== undefined)
    return Effect.fail(new Usage({ detail: "--setup requires --new-worktree." }));
  return Effect.void;
};
