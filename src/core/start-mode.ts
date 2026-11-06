import { Effect } from "effect";
import { Usage } from "../errors";

interface StartMode {
  readonly newWorktree?: boolean;
  readonly worktree?: string | undefined;
  readonly from?: string | undefined;
  readonly setup?: string | undefined;
}

/** The daemon's managed-mode source directory is not a prepared worktree. */
export const validateStartMode = (input: StartMode) =>
  Boolean(input.newWorktree) === (input.worktree !== undefined) ||
  (!input.newWorktree && (input.from !== undefined || input.setup !== undefined))
    ? Effect.fail(new Usage())
    : Effect.void;
