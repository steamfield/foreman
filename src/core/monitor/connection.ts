import { Effect, FileSystem, Path, Schema } from "effect";
import { outdated, probe } from "../../daemon/client";
import { DaemonLockOwner } from "../../schemas/daemon";

/** One feed owns this watch. An incompatible PID is never pinged again. */
export function connection(home: string, build: string) {
  let pid: number | null = null;
  let outdatedPid: number | null = null;
  return {
    incompatible: () => {
      outdatedPid = pid;
    },
    check: Effect.gen(function* () {
      if (outdatedPid !== null) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (yield* fs.exists(path.join(home, "foreman.sock"))) {
          const owner = yield* fs
            .readFileString(path.join(home, "daemon.lock"))
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonLockOwner))),
              Effect.result,
            );
          if (owner._tag !== "Success" || owner.success.pid === outdatedPid)
            return "outdated" as const;
        }
      }
      const pong = yield* probe(home, true);
      outdatedPid = null;
      if (pong === null) return "no-daemon" as const;
      pid = pong._tag === "Pong" ? pong.pid : null;
      if (pong._tag === "Pong" && !outdated(pong, build, { dataDir: home })) return "live" as const;
      outdatedPid = pid;
      return "outdated" as const;
    }),
  };
}
