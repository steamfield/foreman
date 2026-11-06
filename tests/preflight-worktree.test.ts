import { execFileSync } from "node:child_process";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../src/core/preflight/command";
import { validateWorktree } from "../src/core/preflight/worktree";
import { groupFor } from "../src/supervisor/wait";

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const main = path.join(root, "repo");
  execFileSync("git", ["init", "-q", main]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", main, ...args], { encoding: "utf8" }).trim();
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  const worktree = path.join(main, "work trees", "unit");
  git("worktree", "add", "-qb", "unit", worktree);
  return { fs, path, root, main, worktree, git };
});

it.effect(
  "returns the canonical linked worktree, main checkout and HEAD, including symlink input",
  () =>
    Effect.gen(function* () {
      const { fs, path, root, main, worktree, git } = yield* setup();
      const expected = { worktree, mainCheckout: main, baseCommit: git("rev-parse", "HEAD") };
      expect(yield* validateWorktree(worktree)).toEqual(expected);
      const alias = path.join(root, "alias");
      yield* fs.symlink(worktree, alias);
      expect(yield* validateWorktree(alias)).toEqual(expected);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves meaningful trailing whitespace in a linked worktree path", () =>
  Effect.gen(function* () {
    const { path, main, git } = yield* setup();
    const worktree = path.join(main, "trailing-space ");
    git("worktree", "add", "-qb", "trailing", worktree);
    expect(yield* validateWorktree(worktree)).toEqual({
      worktree,
      mainCheckout: main,
      baseCommit: git("rev-parse", "HEAD"),
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("groups alias and linked worktree paths by the canonical main checkout", () =>
  Effect.gen(function* () {
    const { fs, path, root, main, worktree } = yield* setup();
    const alias = path.join(root, "main-alias");
    yield* fs.symlink(main, alias);
    const expected = yield* fs.realPath(main);
    expect(yield* groupFor(alias)).toBe(expected);
    expect(yield* groupFor(worktree)).toBe(expected);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("collects stdout, stderr and a nonzero exit without blocking on either pipe", () =>
  Effect.gen(function* () {
    const result = yield* commandResult(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7",
      ]),
    );
    expect(result).toEqual({ stdout: "out", stderr: "err", code: 7 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("names rule 1 and the path for a subdirectory, a non-repository and an absent path", () =>
  Effect.gen(function* () {
    const { fs, path, root, worktree } = yield* setup();
    const subdir = path.join(worktree, "subdir");
    yield* fs.makeDirectory(subdir);
    for (const input of [subdir, root, path.join(root, "absent")]) {
      const error = yield* Effect.flip(validateWorktree(input));
      expect(error._tag).toBe("WorktreeInvalid");
      expect(error.detail).toContain("Rule 1:");
      expect(error.detail).toContain(input);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses the main checkout under rule 2 and a sibling linked worktree under rule 3", () =>
  Effect.gen(function* () {
    const { path, root, main, git } = yield* setup();
    const outside = path.join(root, "repo-sibling");
    git("worktree", "add", "-qb", "outside", outside);
    for (const [input, rule] of [
      [main, 2],
      [outside, 3],
    ] as const) {
      const error = yield* Effect.flip(validateWorktree(input));
      expect(error.detail).toContain(`Rule ${rule}: ${input}:`);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rule 4 requires installed dependencies, accepts PnP or node_modules, and can be skipped",
  () =>
    Effect.gen(function* () {
      const { fs, path, worktree } = yield* setup();
      yield* fs.writeFileString(path.join(worktree, "package.json"), "{}");
      expect((yield* Effect.flip(validateWorktree(worktree))).detail).toContain(
        `Rule 4: ${worktree}:`,
      );
      expect((yield* validateWorktree(worktree, true)).worktree).toBe(worktree);
      yield* fs.writeFileString(path.join(worktree, "node_modules"), "not a directory");
      expect((yield* Effect.flip(validateWorktree(worktree))).detail).toContain("Rule 4:");
      yield* fs.writeFileString(path.join(worktree, ".pnp.cjs"), "");
      expect((yield* validateWorktree(worktree)).worktree).toBe(worktree);
      yield* fs.remove(path.join(worktree, ".pnp.cjs"));
      yield* fs.remove(path.join(worktree, "node_modules"));
      yield* fs.makeDirectory(path.join(worktree, "node_modules"));
      expect((yield* validateWorktree(worktree)).worktree).toBe(worktree);
    }).pipe(Effect.provide(NodeServices.layer)),
);
