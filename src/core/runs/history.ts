/**
 * Reads finished and archived runs from disk for the monitor's history view. Read-only: it
 * never repairs, migrates or locks run files, and it never contacts the daemon.
 */
import { DateTime, Effect, FileSystem, Path, type PlatformError, type Schema } from "effect";
import type { RunEvent, RunRecord } from "../../schemas/daemon";
import type { HistoryEntry } from "../../schemas/monitor";
import { contractTitle } from "./normalize";
import * as Store from "./store";

type Candidate = {
  readonly dir: string;
  readonly archived: boolean;
  readonly record: RunRecord;
  readonly mtime: number;
};

const logSkip = (path: string, error: PlatformError.PlatformError | Schema.SchemaError) =>
  Effect.logDebug("history.skip").pipe(Effect.annotateLogs({ path, errorTag: error._tag }));

const directories = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(root).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
    Effect.catch((error) => logSkip(root, error).pipe(Effect.as([]))),
  );
});

const candidates = Effect.fnUntraced(function* (root: string, archived: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Candidate[] = [];
  for (const name of yield* directories(root)) {
    if (name === ".archive" || name.startsWith(".tmp-")) continue;
    const dir = path.join(root, name);
    const loaded = yield* Effect.gen(function* () {
      if ((yield* fs.stat(dir)).type !== "Directory") return null;
      const info = yield* fs.stat(path.join(dir, "run.json"));
      const record = yield* Store.readRun(dir);
      if (!archived && ["starting", "running", "waiting"].includes(record.state)) return null;
      const mtime = info.mtime._tag === "Some" ? info.mtime.value.getTime() : -Infinity;
      return { dir, archived, record, mtime };
    }).pipe(Effect.catch((error) => logSkip(dir, error).pipe(Effect.as(null))));
    if (loaded !== null) found.push(loaded);
  }
  return found;
});

const entry = (
  candidate: Candidate,
  repo: string,
  contract: string,
  events: readonly RunEvent[],
): HistoryEntry => {
  const { record, dir, archived } = candidate;
  const commands = events
    .map(({ event }) => event)
    .filter((event) => event._tag === "Command")
    .filter((event) => event.exitCode !== null);
  return {
    name: record.name,
    repo,
    title: contractTitle(contract),
    state: record.state,
    archived,
    model: record.model,
    effort: record.effort,
    createdAt: record.createdAt,
    endedAt: events.findLast(({ event }) => event._tag === "StateChanged")?.at ?? record.updatedAt,
    turns: record.turns,
    tokensTotal: record.tokens === null ? 0 : record.tokens.input + record.tokens.output,
    commands: {
      total: commands.length,
      failed: commands.filter((command) => command.exitCode !== 0).length,
    },
    filesWritten: new Set(
      events.flatMap(({ event }) => (event._tag === "FileChange" ? event.paths : [])),
    ).size,
    dir,
  };
};

const readEntry = Effect.fnUntraced(function* (candidate: Candidate) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contract = yield* fs
    .readFileString(path.join(candidate.dir, "contract.md"))
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
  const { events } = yield* Store.readEvents(candidate.dir, 0, Number.MAX_SAFE_INTEGER);
  return entry(candidate, path.basename(candidate.record.group), contract, events);
});

const newestEnded = (a: HistoryEntry, b: HistoryEntry) => {
  if (a.endedAt === null && b.endedAt !== null) return 1;
  if (b.endedAt === null && a.endedAt !== null) return -1;
  const time =
    a.endedAt === null || b.endedAt === null
      ? 0
      : DateTime.toEpochMillis(b.endedAt) - DateTime.toEpochMillis(a.endedAt);
  return time || a.name.localeCompare(b.name);
};

/** Archived runs plus inactive current runs, newest ended first, at most `limit` entries. */
export const readHistory = (
  dataDir: string,
  limit: number,
): Effect.Effect<readonly HistoryEntry[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (limit <= 0) return [];
    const path = yield* Path.Path;
    const current = yield* candidates(path.join(dataDir, "runs"), false);
    const archived = yield* candidates(path.join(dataDir, "runs", ".archive"), true);
    const window = [...current, ...archived]
      .sort((a, b) => b.mtime - a.mtime || a.record.name.localeCompare(b.record.name))
      .slice(0, limit);
    const entries: HistoryEntry[] = [];
    for (const candidate of window) {
      const loaded = yield* readEntry(candidate).pipe(
        Effect.catch((error) => logSkip(candidate.dir, error).pipe(Effect.as(null))),
      );
      if (loaded !== null) entries.push(loaded);
    }
    return entries.sort(newestEnded);
  });
