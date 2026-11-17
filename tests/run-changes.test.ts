import { execFileSync } from "node:child_process";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { readChanges, readDiff } from "../src/core/runs/changes";

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  const write = (path: string, text: string) => fs.writeFileString(`${root}/${path}`, text);
  for (const path of ["modified.txt", "deleted.txt", "old name.txt", "with space.txt"])
    yield* write(path, "before\nsecond\n");
  yield* write("old name.txt", "rename source\nunique\n");
  yield* fs.writeFile(`${root}/binary.bin`, new Uint8Array([0, 1, 2]));
  git("add", ".");
  const commit = () =>
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
  commit();
  const base = git("rev-parse", "HEAD").trim();
  yield* write("committed.txt", "new commit\n");
  git("add", "committed.txt");
  commit();
  yield* write("modified.txt", "after\nsecond\nthird\n");
  yield* fs.remove(`${root}/deleted.txt`);
  git("mv", "old name.txt", "new name.txt");
  yield* write("with space.txt", "after\n");
  yield* fs.writeFile(`${root}/binary.bin`, new Uint8Array([0, 3, 4]));
  yield* write("untracked.txt", "one\ntwo");
  yield* fs.writeFile(`${root}/untracked.bin`, new Uint8Array([0, 1, 2]));
  yield* write("large.txt", "a".repeat(1_000_000));
  const contract = "- May change: `modified.txt`, `*space.txt`, `committed.txt`, `untracked.*`\n";
  return { fs, root, base, contract, write };
});

it.effect.each([
  { path: "modified.txt", status: "modified", added: 2, removed: 1, outside: false },
  { path: "committed.txt", status: "added", added: 1, removed: 0, outside: false },
  { path: "deleted.txt", status: "deleted", added: 0, removed: 2, outside: true },
  { path: "new name.txt", status: "renamed", added: 0, removed: 0, outside: true },
  { path: "untracked.txt", status: "untracked", added: 2, removed: 0, outside: false },
  { path: "untracked.bin", status: "untracked", added: null, removed: null, outside: false },
  { path: "with space.txt", status: "modified", added: 1, removed: 2, outside: false },
  { path: "binary.bin", status: "modified", added: null, removed: null, outside: true },
  { path: "large.txt", status: "untracked", added: null, removed: null, outside: true },
])("reports $status $path with counts and scope", (expected) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const changes = yield* readChanges(f.root, f.base, f.contract);
    expect(changes.find((file) => file.path === expected.path)).toEqual(expected);
    expect(changes.map((file) => file.path)).toEqual([
      "binary.bin",
      "committed.txt",
      "deleted.txt",
      "large.txt",
      "modified.txt",
      "new name.txt",
      "untracked.bin",
      "untracked.txt",
      "with space.txt",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads only the requested tracked path", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const diff = yield* readDiff(f.root, f.base, "modified.txt", 100_000);
    expect(diff).toEqual({
      text: expect.stringContaining("@@ -1,2 +1,3 @@\n-before\n+after\n second\n+third\n"),
      truncated: false,
    });
    expect(diff.text.match(/^diff --git /gm)).toHaveLength(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads all tracked changes against the base", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const diff = yield* readDiff(f.root, f.base, null, 100_000);
    expect(diff.truncated).toBe(false);
    for (const text of [
      "committed.txt",
      "deleted.txt",
      "rename to new name.txt",
      "with space.txt",
      "Binary files",
    ])
      expect(diff.text).toContain(text);
    expect(diff.text).not.toContain("untracked.txt");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads an untracked path as a new file", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const diff = yield* readDiff(f.root, f.base, "untracked.txt", 100_000);
    expect(diff).toEqual({
      text: expect.stringContaining("--- /dev/null\n+++ b/untracked.txt\n"),
      truncated: false,
    });
    expect(diff.text).toContain("+one\n+two\n\\ No newline at end of file\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("truncates at the last full line within a UTF-8 byte budget", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.write("modified.txt", "café 🐈\n".repeat(100));
    const full = yield* readDiff(f.root, f.base, "modified.txt", 100_000);
    const maxBytes = new TextEncoder().encode(
      full.text.slice(0, full.text.indexOf("+café") + 8),
    ).length;
    const diff = yield* readDiff(f.root, f.base, "modified.txt", maxBytes);
    expect(diff).toEqual({ text: full.text.slice(0, full.text.indexOf("+café")), truncated: true });
    expect(diff.text.endsWith("\n")).toBe(true);
    expect(new TextEncoder().encode(diff.text).length).toBeLessThanOrEqual(maxBytes);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["changes", "diff"] as const)("%s fails visibly outside a git repo", (kind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const error = yield* kind === "changes"
      ? readChanges(root, "HEAD", "").pipe(Effect.flip)
      : readDiff(root, "HEAD", null, 1000).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "WorktreeInvalid",
      detail: expect.stringContaining("exited"),
    });
    expect(error.detail).toContain(root);
    expect(error.detail).toContain("inspect the Git output");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves tabs, newlines and Unicode in paths and reads empty untracked files", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const path = "untracked\tline\né.txt";
    yield* f.write(path, "café\n");
    yield* f.write("empty.txt", "");
    const changes = yield* readChanges(f.root, f.base, "");
    expect(changes.find((file) => file.path === path)).toEqual({
      path,
      status: "untracked",
      added: 1,
      removed: 0,
      outside: false,
    });
    expect(changes.find((file) => file.path === "empty.txt")).toEqual({
      path: "empty.txt",
      status: "untracked",
      added: 0,
      removed: 0,
      outside: false,
    });
    const diff = yield* readDiff(f.root, f.base, path, 10_000);
    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("new file mode");
    expect(diff.text).toContain("+café\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["missing-target", "."])(
  "lists an untracked symlink to %s without following it",
  (target) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.symlink(target, `${f.root}/link`);
      const changes = yield* readChanges(f.root, f.base, f.contract);
      expect(changes.find((file) => file.path === "link")).toEqual({
        path: "link",
        status: "untracked",
        added: null,
        removed: null,
        outside: true,
      });
      expect(changes).toHaveLength(10);
      expect(changes.find((file) => file.path === "modified.txt")?.added).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("treats a requested tracked path as a literal pathspec", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.write("literal[1].txt", "before\n");
    yield* f.write("literal1.txt", "before\n");
    execFileSync("git", ["add", "."], { cwd: f.root });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "paths"],
      { cwd: f.root },
    );
    yield* f.write("literal[1].txt", "literal\n");
    yield* f.write("literal1.txt", "other\n");
    const diff = yield* readDiff(f.root, f.base, "literal[1].txt", 10_000);
    expect(diff.text).toContain("+literal\n");
    expect(diff.text).not.toContain("+other\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps complete output at the exact byte limit and handles a limit before the first line",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const full = yield* readDiff(f.root, f.base, "modified.txt", 10_000);
      const bytes = new TextEncoder().encode(full.text).length;
      expect(yield* readDiff(f.root, f.base, "modified.txt", bytes)).toEqual(full);
      expect(yield* readDiff(f.root, f.base, "modified.txt", 1)).toEqual({
        text: "",
        truncated: true,
      });
      expect(yield* readDiff(f.root, f.base, "modified.txt", 0)).toEqual({
        text: "",
        truncated: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a bounded prefix even when the diff exceeds the command capture limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.write("modified.txt", "large line\n".repeat(150_000));
    const diff = yield* readDiff(f.root, f.base, "modified.txt", 1024);
    expect(diff.truncated).toBe(true);
    expect(diff.text.startsWith("diff --git")).toBe(true);
    expect(diff.text.endsWith("\n")).toBe(true);
    expect(new TextEncoder().encode(diff.text).length).toBeLessThanOrEqual(1024);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["changes", "diff"] as const)(
  "%s rejects an invalid base with git diagnostics",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* kind === "changes"
        ? readChanges(f.root, "not-a-commit", "").pipe(Effect.flip)
        : readDiff(f.root, "not-a-commit", null, 1000).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "WorktreeInvalid",
        detail: expect.stringContaining("exited 128"),
      });
      expect(error.detail).toContain("not-a-commit");
      expect(error.detail).toContain(f.root);
    }).pipe(Effect.provide(NodeServices.layer)),
);
