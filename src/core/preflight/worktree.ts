import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/process";
import { WorktreeInvalid } from "../../errors";
import { mainCheckout } from "../main-checkout";
import { commandResult } from "./command";

const invalid = (rule: number, worktree: string, reason: string) =>
  new WorktreeInvalid({ detail: `Rule ${rule}: ${worktree}: ${reason}` });

const git = Effect.fnUntraced(function* (worktree: string, rule: number, args: string[]) {
  const result = yield* commandResult(
    ChildProcess.make("git", args, { cwd: worktree, stderr: "ignore" }),
  ).pipe(Effect.mapError(() => invalid(rule, worktree, "could not run git")));
  if (result.code !== 0)
    return yield* invalid(rule, worktree, `git ${args.join(" ")} exited ${result.code}`);
  return result.stdout;
});

export const validateWorktree = Effect.fn("preflight.validateWorktree")(function* (
  input: string,
  skipDepsCheck = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktree = yield* fs
    .realPath(input)
    .pipe(Effect.mapError(() => invalid(1, input, "could not resolve worktree")));
  const top = (yield* git(worktree, 1, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
  if (top !== worktree) return yield* invalid(1, worktree, `not the git worktree root (${top})`);
  const main = yield* mainCheckout(worktree).pipe(
    Effect.mapError(() => invalid(2, worktree, "could not resolve main checkout")),
  );
  if (main === null) return yield* invalid(2, worktree, "could not find main checkout");
  if (main === worktree) return yield* invalid(2, worktree, "is the main checkout");
  const relative = path.relative(main, worktree);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    return yield* invalid(3, worktree, `must lie inside main checkout (${main})`);
  if (!skipDepsCheck) {
    const installed = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(path.join(worktree, "package.json")))) return true;
      for (const [name, type] of [
        ["node_modules", "Directory"],
        [".pnp.cjs", "File"],
      ] as const) {
        const info = yield* fs
          .stat(path.join(worktree, name))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
        if (info?.type === type) return true;
      }
      return false;
    }).pipe(Effect.mapError(() => invalid(4, worktree, "could not inspect dependencies")));
    if (!installed)
      return yield* invalid(4, worktree, "package.json needs node_modules or .pnp.cjs");
  }
  const baseCommit = (yield* git(worktree, 1, ["rev-parse", "HEAD"])).trimEnd();
  return { worktree, mainCheckout: main, baseCommit };
});
