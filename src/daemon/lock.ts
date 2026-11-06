import type { PlatformError } from "effect";
import { Clock, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../core/process";
import { DaemonLockOwner } from "../schemas/daemon";
import { Host } from "../services/host";
import { DaemonSockets } from "./sockets";

const missing = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
  );
const old = (info: FileSystem.File.Info, now: number) =>
  Option.isSome(info.mtime) && now - info.mtime.value.getTime() > 30_000;
const occupied = (error: PlatformError.PlatformError) =>
  error.reason._tag === "AlreadyExists" ||
  (Predicate.hasProperty(error.cause, "code") && error.cause.code === "ENOTEMPTY");

const reclaimable = Effect.fnUntraced(function* (file: string, info: FileSystem.File.Info) {
  const text = yield* (yield* FileSystem.FileSystem).readFileString(file);
  const owner = Schema.decodeUnknownResult(Schema.fromJsonString(DaemonLockOwner))(text);
  // Legacy or torn owner records retain the startup grace period.
  if (owner._tag === "Failure") return old(info, yield* Clock.currentTimeMillis);
  const probe = yield* commandResult(
    ChildProcess.make("/bin/kill", ["-0", String(owner.success.pid)], {
      env: { LC_ALL: "C" },
      extendEnv: true,
    }),
  );
  // EPERM is a live owner too. Only a definite ESRCH permits immediate takeover.
  return probe.code !== 0 && probe.stderr.includes("No such process");
});

// A populated directory cannot replace another populated directory via POSIX rename.
// Removing only an observed owner's unique marker cannot clear a newer owner's guard.
const reclaimGuard = Effect.fn("daemon.reclaimGuard")(function* (dataDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = yield* fs.makeTempDirectoryScoped({ directory: dataDir, prefix: ".reclaim-" });
  const token = path.basename(candidate);
  yield* fs.writeFileString(path.join(candidate, token), "", { mode: 0o600 });
  const guard = path.join(dataDir, "daemon.reclaim");
  const install = fs.rename(candidate, guard).pipe(
    Effect.as(true),
    Effect.catch((error) => (occupied(error) ? Effect.succeed(false) : Effect.fail(error))),
  );
  const acquire = Effect.gen(function* () {
    if (yield* install) return true;
    const entries = yield* missing(fs.readDirectory(guard));
    if (Option.isSome(entries)) {
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries.value) {
        const info = yield* missing(fs.stat(path.join(guard, entry)));
        if (Option.isSome(info) && !old(info.value, now)) return false;
      }
      for (const entry of entries.value) yield* fs.remove(path.join(guard, entry), { force: true });
    }
    return yield* install;
  });
  return yield* Effect.acquireRelease(acquire, (owned) =>
    owned ? fs.remove(path.join(guard, token), { force: true }).pipe(Effect.orDie) : Effect.void,
  );
});

export const takeLock = Effect.fn("daemon.takeLock")(function* (
  dataDir: string,
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sockets = yield* DaemonSockets;
  const lock = path.join(dataDir, "daemon.lock");
  const owner = Schema.encodeSync(Schema.fromJsonString(DaemonLockOwner))({
    pid: (yield* Host).pid,
  });
  const create = fs.writeFileString(lock, owner, { flag: "wx", mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
  );
  if (yield* create) return true;
  const connected = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* (yield* sockets.connect(socketPath)).reader;
    }),
  ).pipe(
    Effect.as(true),
    Effect.catchTag("SocketError", () => Effect.succeed(false)),
    Effect.timeoutOption(1000),
  );
  if (Option.isSome(connected) && connected.value) return false;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      if (!(yield* reclaimGuard(dataDir))) return false;
      // Re-read under the guard; a previous reclaimer may have installed a fresh lock.
      const info = yield* missing(fs.stat(lock));
      if (Option.isSome(info)) {
        if (!(yield* reclaimable(lock, info.value))) return false;
        yield* fs.remove(lock, { force: true });
      }
      return yield* create;
    }),
  );
});

export const releaseLock = Effect.fn("daemon.releaseLock")(function* (
  dataDir: string,
  socketPath: string,
  identity: FileSystem.File.Info,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = path.join(dataDir, "daemon.lock");
  // Shutdown must wait for an in-progress reclaimer before checking file ownership.
  while (true) {
    const released = yield* Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* reclaimGuard(dataDir))) return false;
        const current = yield* missing(fs.stat(lock));
        if (
          Option.isSome(current) &&
          current.value.dev === identity.dev &&
          Option.isSome(current.value.ino) &&
          Option.isSome(identity.ino) &&
          current.value.ino.value === identity.ino.value
        ) {
          yield* fs.remove(socketPath, { force: true });
          yield* fs.remove(lock, { force: true });
        }
        return true;
      }),
    );
    if (released) return;
    yield* Effect.sleep(100);
  }
});
