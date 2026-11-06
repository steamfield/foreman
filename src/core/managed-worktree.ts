import { Effect, Exit, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/process";
import { RunConflict, WorktreeInvalid } from "../errors";
import type { ManagedWorktree, OrphanWorktree, RunName, RunRecord } from "../schemas/daemon";
import { mainCheckout } from "./main-checkout";
import { commandResult } from "./process";
import { readGitStatus } from "./runs/worktree";

const gitResult = (cwd: string, args: string[]) =>
  commandResult(ChildProcess.make("git", args, { cwd, env: { LC_ALL: "C" }, extendEnv: true }));

const git = Effect.fnUntraced(function* (cwd: string, args: string[]) {
  const result = yield* gitResult(cwd, args);
  if (result.code !== 0)
    return yield* new WorktreeInvalid({
      detail: `git ${args.join(" ")} exited ${result.code} in ${cwd}: ${result.stderr.trim()}`,
    });
  return result.stdout.trimEnd();
});

export interface CreatedWorktree {
  readonly worktree: string;
  readonly main: string;
  readonly managed: typeof ManagedWorktree.Type;
}

export const managedWorktreePath = Effect.fnUntraced(function* (cwd: string, name: RunName) {
  const main = yield* mainCheckout(cwd);
  if (main === null) return yield* new WorktreeInvalid({ detail: `Not a git repository: ${cwd}` });
  return (yield* Path.Path).join(main, ".claude/worktrees", name);
});

export const createdWorktreeHasWork = Effect.fnUntraced(function* (created: CreatedWorktree) {
  return (
    (yield* readGitStatus(created.worktree)).length > 0 ||
    (yield* git(created.worktree, ["rev-parse", "HEAD"])) !== created.managed.baseCommit
  );
});

export const removeCreatedWorktree = Effect.fn("worktrees.rollback")(function* (
  created: CreatedWorktree,
) {
  const listing = yield* git(created.main, ["worktree", "list", "--porcelain", "-z"]);
  if (listing.split("\0").includes(`worktree ${created.worktree}`))
    yield* git(created.main, ["worktree", "remove", "--force", created.worktree]);
  yield* git(created.main, ["branch", "-D", created.managed.branch]);
});

export const createWorktree = Effect.fn("worktrees.create")(function* (
  cwd: string,
  name: RunName,
  from?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const main = yield* mainCheckout(cwd);
  if (main === null) return yield* new WorktreeInvalid({ detail: `Not a git repository: ${cwd}` });
  const worktree = path.join(main, ".claude/worktrees", name);
  const branch = `forman/${name}`;
  if (yield* fs.exists(worktree))
    return yield* new WorktreeInvalid({
      detail: `Worktree path already exists: ${worktree}; leave it in place and choose another name.`,
    });
  const baseCommit = yield* git(cwd, ["rev-parse", "--verify", `${from ?? "HEAD"}^{commit}`]);
  const source = yield* gitResult(cwd, ["rev-parse", "--symbolic-full-name", from ?? "HEAD"]);
  const fromRef =
    source.code === 0 && source.stdout.trim().startsWith("refs/heads/")
      ? source.stdout.trim()
      : baseCommit;
  // Check a child path because directory-only ignore patterns need the trailing slash.
  const ignored = yield* gitResult(main, ["check-ignore", "-q", ".claude/worktrees/.forman-probe"]);
  if (ignored.code !== 0 && ignored.code !== 1)
    return yield* new WorktreeInvalid({
      detail: `Could not inspect worktree ignore rules in ${main}`,
    });
  if (ignored.code === 1) {
    const exclude = yield* git(main, ["rev-parse", "--git-path", "info/exclude"]);
    const file = path.resolve(main, exclude);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "\n.claude/worktrees/\n", { flag: "a" });
  }
  yield* fs.makeDirectory(path.dirname(worktree), { recursive: true });
  const created: CreatedWorktree = { worktree, main, managed: { branch, baseCommit, fromRef } };
  // Reserve the branch atomically before worktree add, which can leave a new branch
  // behind on checkout failure. A pre-existing branch is never part of rollback.
  yield* git(main, ["branch", branch, baseCommit]);
  yield* rollbackOnFailure(created, git(main, ["worktree", "add", worktree, branch]));
  return created;
});

export const setupWorktree = Effect.fn("worktrees.setup")(function* (
  worktree: string,
  command: string,
  env: Readonly<Record<string, string>>,
) {
  const result = yield* commandResult(
    ChildProcess.make("/bin/sh", ["-c", command], { cwd: worktree, env, extendEnv: false }),
  );
  if (result.code !== 0)
    return yield* new WorktreeInvalid({
      detail: `Setup exited ${result.code} in ${worktree}: ${command}\n${`${result.stdout}\n${result.stderr}`.trimEnd().split("\n").slice(-20).join("\n").slice(-4096)}`,
    });
});

const ancestor = Effect.fnUntraced(function* (cwd: string, tip: string, target: string) {
  if (target.startsWith("refs/heads/")) {
    const source = yield* gitResult(cwd, ["show-ref", "--verify", "--quiet", target]);
    if (source.code === 1) return false;
    if (source.code !== 0)
      return yield* new WorktreeInvalid({
        detail: `Could not inspect source branch ${target} in ${cwd}`,
      });
  }
  const result = yield* gitResult(cwd, ["merge-base", "--is-ancestor", tip, target]);
  if (result.code !== 0 && result.code !== 1)
    return yield* new WorktreeInvalid({
      detail: `Could not check whether ${tip} is merged into ${target} in ${cwd}`,
    });
  return result.code === 0;
});

export const archiveWorktree = Effect.fn("worktrees.archive")(function* (record: RunRecord) {
  const managed = record.managedWorktree;
  if (!managed) return;
  const fs = yield* FileSystem.FileSystem;
  const conflict = (reason: string) =>
    new RunConflict({
      detail: `${record.worktree} (${managed.branch}) holds ${reason}; keep it with: forman archive ${record.name} --keep-worktree`,
    });
  if (!(yield* fs.exists(record.worktree)))
    return yield* conflict("a missing worktree; inspect its branch before cleanup");
  const checkedOut = yield* gitResult(record.worktree, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (checkedOut.code === 1) return yield* conflict("a detached HEAD");
  if (checkedOut.code !== 0) return yield* conflict("an unreadable checked-out branch");
  const branch = checkedOut.stdout.trimEnd();
  if (branch !== managed.branch)
    return yield* conflict(`a different checked-out branch (${branch})`);
  const files = yield* readGitStatus(record.worktree);
  if (files.length > 0) return yield* conflict(`uncommitted files:\n${files.join("\n")}`);
  const tip = yield* git(record.group, ["rev-parse", "--verify", `refs/heads/${managed.branch}`]);
  if (tip !== managed.baseCommit && !(yield* ancestor(record.group, tip, managed.fromRef)))
    return yield* conflict(
      `unmerged commits:\n${yield* git(record.group, ["log", "--oneline", `${managed.baseCommit}..${tip}`])}`,
    );
  // Git refuses dirty files; expected-OID deletion separately protects concurrent commits.
  yield* git(record.group, ["worktree", "remove", record.worktree]);
  const deleted = yield* gitResult(record.group, [
    "update-ref",
    "-d",
    `refs/heads/${managed.branch}`,
    tip,
  ]);
  if (deleted.code !== 0)
    return yield* conflict(
      "a branch that advanced during cleanup (worktree removed, branch retained)",
    );
});

export const orphanWorktrees = Effect.fn("worktrees.orphans")(function* (
  cwd: string,
  records: readonly RunRecord[],
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(cwd))) return [];
  const main = yield* mainCheckout(cwd);
  if (main === null) return [];
  const path = yield* Path.Path;
  const listing = yield* git(main, ["worktree", "list", "--porcelain", "-z"]);
  const orphans: (typeof OrphanWorktree.Type)[] = [];
  for (const entry of listing.split("\0\0")) {
    const fields = entry.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const branch = fields.find((field) => field.startsWith("branch refs/heads/forman/"))?.slice(18);
    if (!worktree || !branch || records.some((record) => record.worktree === worktree)) continue;
    const relative = path.relative(path.join(main, ".claude/worktrees"), worktree);
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      continue;
    if (!(yield* fs.exists(worktree))) continue;
    const files = yield* readGitStatus(worktree);
    // An orphan has no trustworthy base; conservatively report commits differing from main.
    const holdsWork = files.length > 0 || !(yield* ancestor(main, `refs/heads/${branch}`, "HEAD"));
    orphans.push({ path: worktree, branch, holdsWork });
  }
  return orphans;
});

export const rollbackOnFailure = <A, E, R>(
  created: CreatedWorktree,
  work: Effect.Effect<A, E, R>,
) =>
  work.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? removeCreatedWorktree(created) : Effect.void)),
  );
