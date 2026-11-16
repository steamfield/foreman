import { Effect, type FileSystem, type Path, Stream } from "effect";
import type { DaemonSockets } from "../../daemon/sockets";
import type { DaemonResult, RunName } from "../../schemas/daemon";
import type { Detail } from "../../schemas/monitor";
import type { Host } from "../../services/host";

// The contract between the detail view's data link and its view, like MonitorFeed for the list.

/** Events appended since the previous value; `gap` is true when the log skipped entries. */
type Page = Pick<Extract<DaemonResult, { _tag: "Events" }>, "events" | "gap">;

export type DetailFeed =
  /** A daemon of this build answered; `detail` is current as of `receivedAt` (epoch ms). */
  | ({ readonly _tag: "Live"; readonly detail: Detail; readonly receivedAt: number } & Page)
  /** No compatible daemon: read-only from disk; `nextProbeAt` is the next daemon check. */
  | ({
      readonly _tag: "Saved";
      readonly detail: Detail;
      readonly receivedAt: number;
      readonly reason: "no-daemon" | "outdated";
      readonly nextProbeAt: number;
    } & Page)
  /** A live connection failed; `last` is the latest Detail to keep on screen. */
  | {
      readonly _tag: "Reconnecting";
      readonly last: Detail | null;
      readonly retryAt: number;
      readonly reason: string;
    }
  /** The run no longer exists (archived or never existed). */
  | { readonly _tag: "Archived"; readonly receivedAt: number };

/**
 * Emits whenever the detail of `name` or its event log changes, until the scope closes.
 * Never spawns, replaces or keeps alive a daemon, and never fails.
 */
export const detailFeed = (
  _home: string,
  _name: RunName,
): Stream.Stream<DetailFeed, never, FileSystem.FileSystem | Path.Path | DaemonSockets | Host> =>
  Stream.fromEffect(Effect.die("detailFeed is not implemented"));
