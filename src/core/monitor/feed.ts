import { Cause, Clock, Effect, FileSystem, Path, type PlatformError, Schema, Stream } from "effect";
import { outdated, passiveOverview, probe } from "../../daemon/client";
import type { DaemonSockets } from "../../daemon/sockets";
import type { AppError } from "../../errors";
import { causeFields } from "../../logging";
import { DaemonLockOwner } from "../../schemas/daemon";
import type { Overview } from "../../schemas/monitor";
import { Host } from "../../services/host";
import { diskOverview } from "../runs/disk-overview";

// The contract between the monitor's data link and its view. The link owns how updates arrive
// (daemon long-poll, disk fallback, reconnects); the view only renders the latest feed value.

/** Runs read from disk when no compatible daemon is serving; `daemon` is null. */
export type SavedOverview = Omit<Overview, "daemon" | "version"> & { readonly daemon: null };

export type MonitorFeed =
  /** A daemon of this build answered; `overview` is current as of `receivedAt` (epoch ms). */
  | { readonly _tag: "Live"; readonly overview: Overview; readonly receivedAt: number }
  /**
   * No daemon is running, or the running one is another build: runs are read-only from disk.
   * `nextProbeAt` is when the link checks for a compatible daemon again (epoch ms).
   */
  | {
      readonly _tag: "Saved";
      readonly reason: "no-daemon" | "outdated";
      readonly overview: SavedOverview;
      readonly receivedAt: number;
      readonly nextProbeAt: number;
    }
  /**
   * A live connection failed; `last` is the most recent Live overview to keep on screen, dimmed.
   * `retryAt` is when the next attempt starts (epoch ms).
   */
  | {
      readonly _tag: "Reconnecting";
      readonly last: Overview | null;
      readonly retryAt: number;
      readonly reason: string;
    };

export const SAVED_PROBE_MS = 10_000;
export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;

/**
 * Emits a value whenever what the monitor should show changes, until the scope closes.
 * Never spawns, replaces or keeps alive a daemon. Failures become `Reconnecting` or `Saved`
 * values, so the stream itself does not fail.
 */
export const monitorFeed = (
  home: string,
): Stream.Stream<MonitorFeed, never, FileSystem.FileSystem | Path.Path | DaemonSockets | Host> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const host = yield* Host;
      let last: Overview | null = null;
      let live = false;
      let delay = 0;
      let backoff = RECONNECT_INITIAL_MS;
      let savedContent: string | null = null;
      let lastProbedPid: number | null = null;
      let outdatedPid: number | null = null;
      const next = Effect.gen(function* (): Effect.fn.Return<
        MonitorFeed | null,
        AppError | PlatformError.PlatformError | Schema.SchemaError,
        FileSystem.FileSystem | Path.Path | DaemonSockets
      > {
        yield* Effect.sleep(delay);
        const polling = live;
        let reason: "no-daemon" | "outdated" = "no-daemon";
        if (!live) {
          let shouldProbe = true;
          // Pre-passive daemons refresh idle time even on Ping. Once outdated, only
          // watch disk until the socket disappears or the lock names a replacement PID.
          if (outdatedPid !== null) {
            reason = "outdated";
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            if (yield* fs.exists(path.join(home, "foreman.sock"))) {
              const owner = yield* fs
                .readFileString(path.join(home, "daemon.lock"))
                .pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonLockOwner)),
                  ),
                  Effect.result,
                );
              shouldProbe = owner._tag === "Success" && owner.success.pid !== outdatedPid;
            }
          }
          if (shouldProbe) {
            const pong = yield* probe(home, true);
            outdatedPid = null;
            if (pong !== null) {
              reason = "outdated";
              live = pong._tag === "Pong" && !outdated(pong, host.build, { dataDir: home });
              lastProbedPid = pong._tag === "Pong" ? pong.pid : null;
              if (!live) outdatedPid = lastProbedPid;
            } else reason = "no-daemon";
          }
        }
        if (live) {
          const overview = yield* passiveOverview(home, polling ? last?.version : undefined);
          if (overview !== null && overview.daemon.build === host.build) {
            last = overview;
            delay = 0;
            backoff = RECONNECT_INITIAL_MS;
            savedContent = null;
            return { _tag: "Live", overview, receivedAt: yield* Clock.currentTimeMillis };
          }
          live = false;
          outdatedPid = lastProbedPid;
          reason = "outdated";
        }
        const overview = yield* diskOverview(home);
        const receivedAt = yield* Clock.currentTimeMillis;
        delay = SAVED_PROBE_MS;
        const content = JSON.stringify({ reason, overview });
        if (savedContent === content) return null;
        savedContent = content;
        return { _tag: "Saved", reason, overview, receivedAt, nextProbeAt: receivedAt + delay };
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          live = false;
          savedContent = null;
          delay = backoff;
          backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
          return Effect.gen(function* () {
            yield* (
              Cause.hasDies(cause)
                ? Effect.logError("monitor.reconnecting")
                : Effect.logDebug("monitor.reconnecting")
            ).pipe(Effect.annotateLogs(causeFields(cause)));
            return {
              _tag: "Reconnecting" as const,
              last,
              retryAt: (yield* Clock.currentTimeMillis) + delay,
              reason: "Daemon connection unavailable; retrying.",
            };
          });
        }),
      );
      return Stream.fromEffectRepeat(next).pipe(Stream.filter((value) => value !== null));
    }),
  );
