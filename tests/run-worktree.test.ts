import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { createRun } from "../src/core/runs/store";
import { allowedPaths, computeWorktreeFields, gitStatusCommand } from "../src/core/runs/worktree";
import { RunRecord } from "../src/schemas/daemon";

const record = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
  readFileSync(new URL("./fixtures/runs/run.json", import.meta.url), "utf8"),
);

const setup = Effect.fnUntraced(function* (contract: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const main = path.join(root, "repo");
  execFileSync("git", ["init", "-q", main]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", main, ...args], { encoding: "utf8" });
  for (const name of ["tracked.txt", "dirty.txt", "old.txt"])
    yield* fs.writeFileString(path.join(main, name), "before\n");
  yield* fs.writeFileString(path.join(main, ".gitignore"), ".claude/\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const worktree = path.join(main, ".claude", "worktrees", "unit-a");
  git("worktree", "add", "-q", "-b", "unit-a", worktree);
  for (const name of ["tracked.txt", "dirty.txt", "old.txt", ".gitignore"])
    yield* fs.utimes(path.join(worktree, name), new Date(0), new Date(0));
  yield* fs.writeFileString(path.join(worktree, "dirty.txt"), "already dirty\n");
  const runDir = yield* createRun(
    path.join(root, "data"),
    { ...record, group: main, worktree },
    contract,
  );
  // Control the filesystem clock instead of waiting for mtime resolution.
  yield* fs.utimes(path.join(runDir, "start-mark"), new Date(1000), new Date(1000));
  yield* fs.utimes(path.join(worktree, "dirty.txt"), new Date(0), new Date(0));
  return { fs, path, root, main, worktree, runDir };
});

it.effect(
  "reports tracked and shell writes, individual untracked files, baseline differences and rename targets",
  () =>
    Effect.gen(function* () {
      const { fs, path, worktree, runDir } = yield* setup(
        "- May change: `new/`, `tracked.txt`, `dirty.txt`, `renamed.txt`, `shell.txt`\n",
      );
      yield* fs.writeFileString(path.join(worktree, "tracked.txt"), "changed\n");
      yield* fs.writeFileString(path.join(worktree, "dirty.txt"), "changed again\n");
      yield* fs.makeDirectory(path.join(worktree, "new"));
      yield* fs.writeFileString(path.join(worktree, "new", "file.txt"), "new\n");
      execFileSync("sh", ["-c", "echo generated > shell.txt"], { cwd: worktree });
      execFileSync("git", ["-C", worktree, "mv", "old.txt", "renamed.txt"]);
      const fields = yield* computeWorktreeFields(worktree, runDir);
      expect(fields.filesWritten).toEqual([
        "dirty.txt",
        "new/file.txt",
        "shell.txt",
        "tracked.txt",
      ]);
      expect(fields.newInGitStatus).toEqual(
        [" M tracked.txt", "?? new/file.txt", "?? shell.txt", "R  old.txt -> renamed.txt"].sort(),
      );
      expect(fields.outsideMayChange).toEqual([]);
      const baseline = yield* fs.readFileString(path.join(runDir, "baseline.txt"));
      expect(baseline).toBe(" M dirty.txt");
      expect(gitStatusCommand(worktree).args).toEqual([
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("prunes every dependency, cache and build name, even in nested directories", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, runDir } = yield* setup("no scope\n");
    const dirs = [
      "node_modules",
      "dist",
      "coverage",
      "logs",
      ".dev",
      "cache.tsbuildinfo",
      ".venv",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      "target",
      ".next",
      ".turbo",
      "build",
      ".git",
    ];
    for (const name of dirs) {
      const dir = path.join(worktree, "nested", name);
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "ignored.txt"), "generated\n");
    }
    yield* fs.writeFileString(path.join(worktree, "state.tsbuildinfo"), "also pruned");
    const fields = yield* computeWorktreeFields(worktree, runDir);
    expect(fields.filesWritten).toEqual([]);
    expect(fields.outsideMayChange).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "matches directory entries, exact files, suffixes and multiline scope, retaining strays",
  () =>
    Effect.gen(function* () {
      const { fs, path, worktree, runDir } = yield* setup(
        [
          "# Contract",
          "- May change: `src/`, `only.txt`",
          "  and `lib/file.ts`",
          "",
          "- Must not change: `stray.txt`",
          "",
        ].join("\n"),
      );
      for (const name of [
        "src/a.ts",
        "pkg/src/deep/b.ts",
        "only.txt",
        "pkg/only.txt",
        "pkg/lib/file.ts",
        "stray.txt",
        "only.txt.bak",
      ]) {
        const file = path.join(worktree, name);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "written\n");
      }
      expect((yield* computeWorktreeFields(worktree, runDir)).outsideMayChange).toEqual([
        "dirty.txt",
        "only.txt.bak",
        "stray.txt",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["", "./", "././"])(
  "matches May change stars within segments and globstars across directories, prefix=%s",
  (prefix) =>
    Effect.gen(function* () {
      const { fs, path, worktree, runDir } = yield* setup(
        `- May change: \`dirty.txt\`, \`${prefix}tests/run-*.test.ts\`, \`${prefix}src/**/*.ts\`, \`literal[1].txt\`, \`assets/\`\n`,
      );
      for (const file of [
        "tests/run-store.test.ts",
        "tests/run-deep/nested.test.ts",
        "tests/other.test.ts",
        "src/main.ts",
        "src/core/nested/file.ts",
        "src/core/file.ts.bak",
        "literal[1].txt",
        "literal1.txt",
        "assets/deep/file.bin",
      ]) {
        yield* fs.makeDirectory(path.dirname(path.join(worktree, file)), { recursive: true });
        yield* fs.writeFileString(path.join(worktree, file), "written\n");
      }
      expect((yield* computeWorktreeFields(worktree, runDir)).outsideMayChange).toEqual([
        "literal1.txt",
        "src/core/file.ts.bak",
        "tests/other.test.ts",
        "tests/run-deep/nested.test.ts",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns empty worktree lists when there are no new writes or status entries", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, runDir } = yield* setup("- May change: `dirty.txt`\n");
    expect(yield* computeWorktreeFields(worktree, runDir)).toEqual({
      filesWritten: [],
      newInGitStatus: [],
      outsideMayChange: [],
    });
    yield* fs.writeFileString(path.join(runDir, "contract.md"), "- May change: no backticks\n");
    expect((yield* computeWorktreeFields(worktree, runDir)).outsideMayChange).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails visibly when git cannot inspect the worktree", () =>
  Effect.gen(function* () {
    const { fs, path, root, runDir } = yield* setup("no scope\n");
    const absent = path.join(root, "not-a-repo");
    yield* fs.makeDirectory(absent);
    expect(yield* Effect.flip(computeWorktreeFields(absent, runDir))).toMatchObject({
      _tag: "WorktreeInvalid",
      detail: expect.stringContaining("git exited 128"),
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("reads May change only until the next item or blank line", () => {
  expect(allowedPaths("- May change: `src/`\n  `file.ts`\n- Must not: `private/`\n")).toEqual([
    "src/",
    "file.ts",
  ]);
  expect(allowedPaths("- May change: `src/`\n\n`not-allowed`\n")).toEqual(["src/"]);
});
