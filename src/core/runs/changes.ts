/**
 * Reads a run's code change from its worktree for the monitor: the changed files with line
 * counts, and unified diff text. Read-only git commands with --no-optional-locks; never
 * touches the index or refs. Runs on demand, never on a timer.
 */
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import { WorktreeInvalid } from "../../errors";
import { commandResult, diagnosticTail } from "../process";
import { parseCounts, parseStatuses, untrackedPaths } from "./change-status";
import { allowedPaths, covers } from "./worktree";

/** One changed path against the run's base commit, including untracked files. */
export type ChangedFile = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Null when counts are unavailable, including binary files and symlinks. */
  readonly added: number | null;
  readonly removed: number | null;
  /** True when the path falls outside the contract's May change list. */
  readonly outside: boolean;
};

/** Diff text, cut at `maxBytes` with `truncated` set. */
export type DiffText = { readonly text: string; readonly truncated: boolean };

const gitCommand = (worktree: string, args: readonly string[]) =>
  ChildProcess.make("git", ["--no-optional-locks", ...args], { cwd: worktree });

const commandFailure = (command: ChildProcess.StandardCommand, code: number, stderr: string) =>
  new WorktreeInvalid({
    detail: `${CommandLine.display([command.command, ...command.args])} exited ${code} in ${command.options.cwd}:\n${diagnosticTail(stderr)}\nPlease inspect the ${command.command === "git" ? "Git" : "command"} output and resolve the reported issue before retrying.`,
  });

const output = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
  const result = yield* commandResult(command).pipe(
    Effect.mapError((error) => new WorktreeInvalid({ detail: error.detail })),
  );
  if (result.code !== 0) return yield* commandFailure(command, result.code, result.stderr);
  return result.stdout;
});

const untrackedCounts = Effect.fnUntraced(function* (
  worktree: string,
  path: string,
  countLines: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${worktree}/${path}`;
  return yield* Effect.gen(function* () {
    const info = yield* fs.lstat(file);
    if (!countLines || info.type !== "File" || info.size >= 1_000_000n)
      return { added: null, removed: null };
    const bytes = yield* fs.readFile(file);
    if (bytes.length >= 1_000_000 || bytes.includes(0)) return { added: null, removed: null };
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    if (bytes.length > 0 && bytes.at(-1) !== 10) lines++;
    return { added: lines, removed: 0 };
  }).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    Effect.mapError((error) =>
      Object.assign(
        new WorktreeInvalid({
          detail: `Could not read ${file}: ${error.reason.method} (${error.reason._tag}). Check file permissions before retrying.`,
        }),
        { cause: error },
      ),
    ),
  );
});

const capturePrefix = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  yield* Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      const kept = chunk.subarray(0, Math.max(0, maxBytes - length));
      if (kept.length > 0) chunks.push(kept.slice());
      length += kept.length;
      truncated ||= kept.length < chunk.length;
    }),
  );
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const end = truncated ? bytes.lastIndexOf(10) + 1 : bytes.length;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated };
});

const diffOutput = (command: ChildProcess.StandardCommand, maxBytes: number, noIndex: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          ...command.options,
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        }),
      );
      const [diff, stderr, code] = yield* Effect.all(
        [
          capturePrefix(handle.stdout, maxBytes),
          capturePrefix(handle.stderr, 4096),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0 && !(noIndex && code === 1))
        return yield* commandFailure(command, code, stderr.text);
      return diff;
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof WorktreeInvalid
        ? error
        : new WorktreeInvalid({
            detail: `Could not run ${CommandLine.display([command.command, ...command.args])} in ${command.options.cwd}: ${error.reason.method} (${error.reason._tag}). Inspect the Git output and directory permissions before retrying.`,
          }),
    ),
  );

/**
 * Lists the worktree's changes against `baseCommit`, sorted by path.
 *
 * @throws {WorktreeInvalid} When Git or an untracked file cannot be read.
 */
export const readChanges = (
  worktree: string,
  baseCommit: string,
  contract: string,
): Effect.Effect<
  readonly ChangedFile[],
  WorktreeInvalid,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const counts = parseCounts(
      yield* output(
        gitCommand(worktree, ["diff", "--numstat", "-z", "--find-renames", baseCommit]),
      ),
    );
    const statuses = parseStatuses(
      yield* output(
        gitCommand(worktree, ["diff", "--name-status", "-z", "--find-renames", baseCommit]),
      ),
    );
    const untracked = untrackedPaths(
      yield* output(
        gitCommand(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      ),
    );
    const loaded = yield* Effect.forEach(
      untracked,
      (path, index) => untrackedCounts(worktree, path, index < 200),
      { concurrency: 8 },
    );
    for (const [index, path] of untracked.entries()) {
      const count = loaded[index];
      if (!count) continue;
      statuses.set(path, "untracked");
      counts.set(path, count);
    }
    const allowed = allowedPaths(contract);
    return [...statuses]
      .map(([path, status]) => ({
        path,
        status,
        ...(counts.get(path) ?? { added: null, removed: null }),
        outside: allowed.length > 0 && !allowed.some((entry) => covers(path, entry)),
      }))
      .sort((a, b) => {
        if (a.path < b.path) return -1;
        return a.path > b.path ? 1 : 0;
      });
  });

/**
 * Reads the unified diff against `baseCommit` for one path, or all paths when `path` is null.
 *
 * @throws {WorktreeInvalid} When git fails in the worktree.
 */
export const readDiff = (
  worktree: string,
  baseCommit: string,
  path: string | null,
  maxBytes: number,
): Effect.Effect<DiffText, WorktreeInvalid, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      return yield* new WorktreeInvalid({
        detail: "Diff byte limit must be a non-negative integer.",
      });
    const status = yield* output(
      gitCommand(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    );
    const noIndex = path !== null && untrackedPaths(status).includes(path);
    const args = noIndex
      ? ["diff", "--no-color", "--no-index", "--", "/dev/null", path]
      : [
          "diff",
          "--no-color",
          "--find-renames",
          baseCommit,
          ...(path === null ? [] : ["--", `:(literal)${path}`]),
        ];
    return yield* diffOutput(gitCommand(worktree, args), maxBytes, noIndex);
  });
