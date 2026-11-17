/**
 * Reads finished and archived runs from disk for the monitor's history view. Read-only: it
 * never repairs, migrates or locks run files, and it never contacts the daemon.
 */
import type { Effect, FileSystem, Path } from "effect";
import type { HistoryEntry } from "../../schemas/monitor";

/** Archived runs plus inactive current runs, newest ended first, at most `limit` entries. */
export const readHistory = (
  _dataDir: string,
  _limit: number,
): Effect.Effect<readonly HistoryEntry[], never, FileSystem.FileSystem | Path.Path> => {
  throw new Error("not implemented");
};
