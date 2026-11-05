import { Effect, FileSystem, Path, type PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { WorktreeInvalid } from "../../errors";
import type { Digest } from "../../schemas/daemon";

export type WorktreeFields = Pick<Digest, "filesWritten" | "newInGitStatus" | "outsideMayChange">;

export const gitStatusCommand = (worktree: string) =>
  ChildProcess.make(
    "git",
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    {
      cwd: worktree,
    },
  );

const commandOutput = Effect.fn("runs.commandOutput")(function* (
  command: ChildProcess.StandardCommand,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* new WorktreeInvalid({
          detail: `${command.command} exited ${code} in ${command.options.cwd}: ${stderr.trim()}`,
        });
      return stdout;
    }),
  );
});

const sortedLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .sort();

export const readGitStatus = Effect.fn("runs.readGitStatus")(function* (worktree: string) {
  return sortedLines(yield* commandOutput(gitStatusCommand(worktree)));
});

const prunedNames = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "logs",
  ".dev",
  "*.tsbuildinfo",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
  ".next",
  ".turbo",
  "build",
];

export function allowedPaths(contract: string): readonly string[] {
  const section: string[] = [];
  let inside = false;
  for (const line of contract.split("\n")) {
    if (line.startsWith("- May change:")) inside = true;
    else if (line === "" || line.startsWith("- ")) inside = false;
    if (inside) section.push(line);
  }
  return [...section.join("\n").matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "");
}

function covers(path: string, entry: string): boolean {
  if (entry.endsWith("/")) return path.startsWith(entry) || path.includes(`/${entry}`);
  return path === entry || path.endsWith(`/${entry}`);
}

export const computeWorktreeFields = Effect.fn("runs.computeWorktreeFields")(function* (
  worktree: string,
  runDir: string,
): Effect.fn.Return<
  WorktreeFields,
  PlatformError.PlatformError | WorktreeInvalid,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const status = yield* readGitStatus(worktree);
  const baseline = new Set(
    sortedLines(yield* fs.readFileString(path.join(runDir, "baseline.txt"))),
  );
  const allowed = allowedPaths(yield* fs.readFileString(path.join(runDir, "contract.md")));
  const pruneArgs = prunedNames.flatMap((name, index) =>
    index === 0 ? ["-name", name] : ["-o", "-name", name],
  );
  const touched = yield* commandOutput(
    ChildProcess.make(
      "find",
      [
        ".",
        "(",
        ...pruneArgs,
        ")",
        "-prune",
        "-o",
        "-type",
        "f",
        "-newer",
        path.join(runDir, "start-mark"),
        "-print",
      ],
      { cwd: worktree },
    ),
  );
  return {
    filesWritten: sortedLines(touched).map((file) => file.replace(/^\.\//, "")),
    newInGitStatus: status.filter((line) => !baseline.has(line)),
    outsideMayChange:
      allowed.length === 0
        ? null
        : status
            .map((line) => line.slice(3).replace(/.* -> /, ""))
            .filter((file) => !allowed.some((entry) => covers(file, entry))),
  };
});
