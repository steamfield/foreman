import { Effect, FileSystem, Path, type PlatformError } from "effect";
import { ChildProcess } from "effect/process";
import { PermissionDenied, WorktreeInvalid } from "../../errors";
import { mainCheckout } from "../main-checkout";
import { commandResult, diagnosticTail } from "../process";

const remedies = {
  1: "Choose an accessible Git worktree root and retry.",
  2: "Choose a linked worktree instead of the main checkout and retry.",
  3: "Choose a linked worktree inside the main checkout and retry.",
  4: "Check permissions and install dependencies in the worktree, or use --skip-deps-check if appropriate.",
} as const;
const invalid = (rule: keyof typeof remedies, worktree: string, reason: string) =>
  new WorktreeInvalid({ detail: `Rule ${rule}: ${worktree}: ${reason}. ${remedies[rule]}` });

const inspectionError = (
  rule: keyof typeof remedies,
  worktree: string,
  error: PlatformError.PlatformError,
) =>
  error.reason._tag === "PermissionDenied"
    ? new PermissionDenied({
        detail: `Cannot inspect worktree ${worktree}: ${error.reason.method}${"pathOrDescriptor" in error.reason ? ` at ${error.reason.pathOrDescriptor}` : ""}. Check file and directory permissions, then retry.`,
      })
    : invalid(rule, worktree, `${error.reason.method} failed (${error.reason._tag})`);

const git = Effect.fnUntraced(function* (
  worktree: string,
  rule: keyof typeof remedies,
  args: string[],
) {
  const result = yield* commandResult(
    ChildProcess.make("git", args, { cwd: worktree, stderr: "ignore" }),
  );
  if (result.code !== 0)
    return yield* invalid(
      rule,
      worktree,
      `git ${args.join(" ")} exited ${result.code}:\n${diagnosticTail(result.stdout)}\n${diagnosticTail(result.stderr)}`,
    );
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
    .pipe(Effect.mapError((error) => inspectionError(1, input, error)));
  const top = (yield* git(worktree, 1, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
  if (top !== worktree) return yield* invalid(1, worktree, `not the git worktree root (${top})`);
  const main = yield* mainCheckout(worktree).pipe(
    Effect.mapError((error) =>
      error instanceof WorktreeInvalid || error instanceof PermissionDenied
        ? error
        : inspectionError(2, worktree, error),
    ),
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
    }).pipe(Effect.mapError((error) => inspectionError(4, worktree, error)));
    if (!installed)
      return yield* invalid(4, worktree, "package.json needs node_modules or .pnp.cjs");
  }
  const baseCommit = (yield* git(worktree, 1, ["rev-parse", "HEAD"])).trimEnd();
  return { worktree, mainCheckout: main, baseCommit };
});
