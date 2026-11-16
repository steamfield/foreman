import { Effect, Stream } from "effect";
import type { Overview } from "../../schemas/monitor";

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

/**
 * Emits a value whenever what the monitor should show changes, until the scope closes.
 * Never spawns, replaces or keeps alive a daemon. Failures become `Reconnecting` or `Saved`
 * values, so the stream itself does not fail.
 */
export const monitorFeed = (_home: string): Stream.Stream<MonitorFeed> =>
  Stream.fromEffect(Effect.die("monitorFeed is not implemented"));
