import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import { DaemonUnavailable } from "../errors";
import { DaemonLockOwner } from "../schemas/daemon";
import { Host } from "../services/host";

const lockError = (database: string) =>
  new DaemonUnavailable({
    detail: `Could not acquire daemon ownership using ${database}; check its path and permissions, and use a local filesystem with advisory locking.`,
  });

// SQLite supplies OS advisory locking in both Node and Bun without a native addon.
// Never unlink this database: all contenders must lock the same inode. No data is stored.
export const takeLock = Effect.fn("daemon.takeLock")(function* (dataDir: string) {
  const path = yield* Path.Path;
  const databasePath = path.join(dataDir, "daemon.guard.sqlite");
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(databasePath),
      catch: () => lockError(databasePath),
    }),
    (database) => Effect.sync(() => database.close()),
  );
  return yield* Effect.try({
    try: () => {
      try {
        database.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
        return true;
      } catch (error) {
        // SQLITE_BUSY is the only failure that establishes another owner.
        if (Predicate.hasProperty(error, "errcode") && error.errcode === 5) return false;
        throw error;
      }
    },
    catch: () => lockError(databasePath),
  });
});

export const recordOwner = Effect.fn("daemon.recordOwner")(function* (dataDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owner = Schema.encodeSync(Schema.fromJsonString(DaemonLockOwner))({
    pid: (yield* Host).pid,
  });
  yield* fs.writeFileString(path.join(dataDir, "daemon.lock"), owner, { mode: 0o600 });
});

export const releaseLock = Effect.fn("daemon.releaseLock")(function* (
  dataDir: string,
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Called only while the advisory lock is held, after every owned worker has joined.
  yield* fs.remove(socketPath, { force: true });
  yield* fs.remove(path.join(dataDir, "daemon.lock"), { force: true });
});
