import { NodeServices } from "@effect/platform-node";
import { assert, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/process";
import {
  createWorktree,
  removeCreatedWorktree,
  rollbackOnFailure,
} from "../src/core/managed-worktree";
import { commandResult } from "../src/core/process";
import { WorktreeInvalid } from "../src/errors";
import { RunName } from "../src/schemas/daemon";

const name = Schema.decodeUnknownSync(RunName)("unit");
const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repo = `${root}/repo`;
  yield* fs.makeDirectory(repo);
  const realGit = (yield* commandResult(ChildProcess.make("which", ["git"]))).stdout.trim();
  const git = (args: string[], cwd = repo) =>
    commandResult(ChildProcess.make(realGit, args, { cwd })).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.code, result.stderr).toBe(0))),
    );
  yield* git(["init", "-q"]);
  yield* git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const worktree = `${repo}/.claude/worktrees/unit`;
  const inject = Effect.fnUntraced(function* (body: string) {
    yield* fs.writeFileString(`${root}/git`, `#!/bin/sh\n${body}\nexec '${realGit}' "$@"\n`, {
      mode: 0o755,
    });
    const previous = process.env.PATH;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${root}:${previous ?? ""}`;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.PATH;
          else process.env.PATH = previous;
        }),
    );
  });
  return { fs, root, repo, worktree, realGit, git, inject };
});

it.live("failed worktree add preserves a racing foreign worktree and its dirty files", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.inject(`if [ "$1" = worktree ] && [ "$2" = add ]; then
  '${f.realGit}' -C '${f.repo}' worktree add -qb foreign '${f.worktree}'
  printf keep > '${f.worktree}/foreign.txt'
fi`);
    yield* createWorktree(f.repo, name).pipe(Effect.flip);
    expect(yield* f.fs.readFileString(`${f.worktree}/foreign.txt`)).toBe("keep");
    expect((yield* f.git(["branch", "--list", "foreman/unit"])).stdout).toBe("");
    expect((yield* f.git(["symbolic-ref", "--short", "HEAD"], f.worktree)).stdout.trim()).toBe(
      "foreign",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["dirty", "committed", "branch", "replacement"] as const)(
  "rollback retains an owned path after %s work changes its identity or contents",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const created = yield* createWorktree(f.repo, name);
      if (kind === "dirty") yield* f.fs.writeFileString(`${f.worktree}/work.txt`, "keep");
      if (kind === "committed")
        yield* f.git(
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "work",
          ],
          f.worktree,
        );
      if (kind === "branch") yield* f.git(["checkout", "-qb", "other"], f.worktree);
      if (kind === "replacement") {
        yield* f.git(["worktree", "remove", f.worktree]);
        yield* f.git(["worktree", "add", f.worktree, "foreman/unit"]);
      }
      const before = (yield* f.git(["rev-parse", "refs/heads/foreman/unit"])).stdout;
      const result = yield* removeCreatedWorktree(created).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* f.fs.exists(f.worktree)).toBe(true);
      expect((yield* f.git(["rev-parse", "refs/heads/foreman/unit"])).stdout).toBe(before);
      if (kind === "dirty")
        expect(yield* f.fs.readFileString(`${f.worktree}/work.txt`)).toBe("keep");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "rollback uses the original branch OID when a concurrent commit arrives during removal",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const created = yield* createWorktree(f.repo, name);
      const next = (yield* f.git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "concurrent",
      ])).stdout.trim();
      yield* f.inject(
        `if [ "$1" = worktree ] && [ "$2" = remove ]; then '${f.realGit}' -C '${f.repo}' update-ref refs/heads/foreman/unit '${next}'; fi`,
      );
      const error = yield* rollbackOnFailure(
        created,
        Effect.fail(new WorktreeInvalid({ detail: "preflight refused" })),
      ).pipe(Effect.flip);
      assert.instanceOf(error, WorktreeInvalid);
      expect(error.detail).toContain("refs/heads/foreman/unit");
      expect(error.detail).not.toContain(`Rollback retained ${f.worktree}`);
      expect(yield* f.fs.exists(f.worktree)).toBe(false);
      expect((yield* f.git(["rev-parse", "refs/heads/foreman/unit"])).stdout.trim()).toBe(next);
    }).pipe(Effect.provide(NodeServices.layer)),
);
