import { Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import { WorktreeInvalid } from "../errors";
import { commandResult, diagnosticTail } from "./process";

/** Null means outside git; discovery failures remain failures for callers to report. */
export const mainCheckout = Effect.fn("mainCheckout")(function* (cwd: string) {
  const listing = yield* commandResult(
    ChildProcess.make("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
      env: { LC_ALL: "C" },
      extendEnv: true,
    }),
  );
  if (listing.code !== 0) {
    if (
      listing.stderr.startsWith(
        "fatal: not a git repository (or any of the parent directories): .git",
      )
    )
      return null;
    return yield* new WorktreeInvalid({
      detail: `git worktree list --porcelain -z exited ${listing.code} in ${cwd}: ${diagnosticTail(listing.stderr)}\nPlease check Git and repository permissions, then retry.`,
    });
  }
  const first = listing.stdout.split("\0")[0];
  if (!first?.startsWith("worktree "))
    return yield* new WorktreeInvalid({
      detail: `git worktree list returned no main checkout in ${cwd}; check Git and repository permissions, then retry.`,
    });
  return yield* (yield* FileSystem.FileSystem).realPath(first.slice("worktree ".length));
});
