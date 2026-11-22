/**
 * The changed-files check for read-only turns on providers whose read-only mode leaves shell
 * commands unsandboxed (agy). A checked turn snapshots the worktree's changed paths with a
 * content hash each when it begins; when it ends, any path that appeared, disappeared or
 * changed fails the turn. The snapshot rules are plain functions; git runs only in
 * `readSnapshot`.
 */
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../core/process";
import { readGitStatus } from "../core/runs/worktree";
import { WorktreeInvalid } from "../errors";
import type { ProviderId } from "../providers/contract";
import { providerOf, type RunRecord, type TurnKind } from "../schemas/daemon";
import type { Registry, Run } from "./registry";

/**
 * Providers whose read-only mode covers their edit tools but not their shell commands, with
 * the warning their read-only runs carry.
 */
export const UNSANDBOXED_READ_ONLY: ReadonlyMap<ProviderId, string> = new Map([
  [
    "agy",
    "read-only on agy blocks agy's edit tools but not shell commands; use a Codex model when you need an enforced read-only sandbox.",
  ],
]);

/**
 * Whether foreman checks the worktree after this turn: a read-only or hand-off turn on a
 * provider whose read-only mode leaves shell commands unsandboxed.
 */
export function checksReadOnly(record: RunRecord, kind: TurnKind): boolean {
  if (!UNSANDBOXED_READ_ONLY.has(providerOf(record))) return false;
  return record.sandbox === "read-only" || kind === "handoff";
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Undoes git's C-style path quoting (`"new file.txt"`, `"caf\303\251"`); other paths pass through. */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const body = path.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body.charAt(index);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const escaped = body.charAt(index + 1);
    bytes.push(C_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path a `git status --porcelain` line names; the destination for a rename. */
export const statusPath = (line: string) => unquoteGitPath(line.slice(3).replace(/.* -> /, ""));

/**
 * Pairs each changed path with its status code and content hash, so a rewrite of a file that
 * was already modified still reads as a change. `hashes` has no entry for a deleted path.
 */
export function snapshotOf(
  statusLines: readonly string[],
  hashes: ReadonlyMap<string, string>,
): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const line of statusLines) {
    const path = statusPath(line);
    snapshot.set(path, `${line.slice(0, 2)} ${hashes.get(path) ?? "-"}`);
  }
  return snapshot;
}

/** The paths that appeared, disappeared or changed between two snapshots, sorted. */
export function changedSince(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [path, signature] of after) if (before.get(path) !== signature) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

const isSpecial = (char: string) => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || char === "\\" || char === '"';
};
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\t": "\\t",
};

/**
 * One line of `git hash-object --stdin-paths` input for `path`. Git C-unquotes a line that
 * starts with a double quote and splits lines at newlines, so a path with a newline, a
 * backslash, a double quote or another control character is quoted the way git quotes names.
 * @throws Never; pure.
 */
export function stdinPathLine(path: string): string {
  const chars = [...path];
  if (!chars.some(isSpecial)) return path;
  const body = chars.map((char) => {
    if (!isSpecial(char)) return char;
    return SIMPLE_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`;
  });
  return `"${body.join("")}"`;
}

/**
 * Hashes the files `git hash-object` can read in the worktree.
 * @throws {WorktreeInvalid} When git fails.
 */
const hashFiles = Effect.fnUntraced(function* (worktree: string, paths: readonly string[]) {
  if (paths.length === 0) return new Map<string, string>();
  // Paths go on stdin, one per line: a large untracked tree would overflow argv (ARG_MAX).
  const result = yield* commandResult(
    ChildProcess.make("git", ["hash-object", "--stdin-paths"], {
      cwd: worktree,
      stdin: Stream.make(new TextEncoder().encode(`${paths.map(stdinPathLine).join("\n")}\n`)),
    }),
  );
  if (result.code !== 0)
    return yield* new WorktreeInvalid({
      detail: `git hash-object exited ${result.code} in ${worktree}: ${result.stderr.trim()}. Inspect the worktree, then run foreman status.`,
    });
  const hashes = result.stdout.split("\n").filter((line) => line !== "");
  return new Map(paths.map((path, index): [string, string] => [path, hashes[index] ?? "-"]));
});

/**
 * Reads the worktree's changed paths with a content signature each.
 * @throws {WorktreeInvalid} When git fails in the worktree.
 */
export const readSnapshot = Effect.fnUntraced(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lines = yield* readGitStatus(worktree);
  const files: string[] = [];
  for (const line of lines) {
    const changed = statusPath(line);
    const info = yield* fs
      .stat(path.join(worktree, changed))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    if (info?.type === "File") files.push(changed);
  }
  return snapshotOf(lines, yield* hashFiles(worktree, files));
});

/**
 * The snapshot a turn of `kind` starts from: taken before the turn starts, so status refreshes
 * during the turn can't move the baseline. Null for turns that aren't checked.
 * @throws {WorktreeInvalid} When git fails in the worktree.
 */
export const turnStartSnapshot = (record: RunRecord, kind: TurnKind) =>
  checksReadOnly(record, kind) ? readSnapshot(record.worktree) : Effect.succeed(null);

/**
 * Compares the worktree with the snapshot taken when a checked turn began, recording a
 * warning; returns the run failure when the turn changed files. Turns without a snapshot
 * aren't checked.
 * @throws {WorktreeInvalid} When git fails in the worktree.
 */
export const checkReadOnlyTurn = Effect.fnUntraced(function* (registry: Registry, run: Run) {
  const before = run.turnSnapshot;
  run.turnSnapshot = null;
  if (before === null) return null;
  const fs = yield* FileSystem.FileSystem;
  // A removed worktree has nothing left to check; the digest reports the removal.
  if (!(yield* fs.exists(run.record.worktree))) return null;
  const changed = changedSince(before, yield* readSnapshot(run.record.worktree));
  if (changed.length === 0) return null;
  const message = `read-only ${providerOf(run.record)} run changed files: ${changed.join(", ")}`;
  if (!run.record.warnings.includes(message))
    yield* registry.save(run, { warnings: [...run.record.warnings, message] });
  return { message, codexErrorInfo: null };
});
