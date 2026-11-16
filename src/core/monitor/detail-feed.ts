import {
  Cause,
  Clock,
  DateTime,
  Effect,
  type FileSystem,
  type Path,
  type PlatformError,
  type Schema,
  Stream,
} from "effect";
import { passiveDetail, passiveEvents } from "../../daemon/client";
import type { DaemonSockets } from "../../daemon/sockets";
import { type AppError, DaemonUnavailable } from "../../errors";
import { causeFields } from "../../logging";
import type { DaemonResult, RunName } from "../../schemas/daemon";
import type { Detail } from "../../schemas/monitor";
import { Host } from "../../services/host";
import { diskDetail } from "../runs/disk-detail";
import * as Store from "../runs/store";
import { connection } from "./connection";
import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, SAVED_PROBE_MS } from "./feed";

type AwaitedPage = Effect.Success<ReturnType<typeof passiveEvents>>;

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
  home: string,
  name: RunName,
): Stream.Stream<DetailFeed, never, FileSystem.FileSystem | Path.Path | DaemonSockets | Host> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const watch = connection(home, (yield* Host).build);
      let last: Detail | null = null;
      let live = false;
      let delay = 0;
      let backoff = RECONNECT_INITIAL_MS;
      let cursor = 0;
      let createdAt: number | null = null;
      let draining = false;
      let savedContent: string | null = null;
      const resetCursor = (detail: Detail) => {
        const identity = DateTime.toEpochMillis(detail.record.createdAt);
        const replaced = createdAt !== null && createdAt !== identity;
        if (replaced) {
          cursor = 0;
          draining = false;
        }
        createdAt = identity;
        return replaced;
      };
      const next = Effect.gen(function* (): Effect.fn.Return<
        DetailFeed | null,
        AppError | PlatformError.PlatformError | Schema.SchemaError,
        FileSystem.FileSystem | Path.Path | import("../../daemon/sockets").DaemonSockets
      > {
        yield* Effect.sleep(delay);
        const polling = live;
        let reason: "no-daemon" | "outdated" = "no-daemon";
        if (!live) {
          const status = yield* watch.check;
          live = status === "live";
          if (status !== "live") reason = status;
        }
        if (live) {
          let detail: Detail | null;
          let page: AwaitedPage;
          if (polling && !draining && last !== null) {
            // Either change wakes the consumer. raceFirst closes the losing socket before
            // the immediate counterpart read, so event backlogs never wait on Detail.
            const update = yield* Effect.raceFirst(
              passiveDetail(home, name, last.version).pipe(
                Effect.map((detail) => ({ _tag: "Detail" as const, detail })),
              ),
              passiveEvents(home, name, cursor, 15_000).pipe(
                // Inactive runs return empty pages immediately. Keep the Detail
                // poll open instead of spinning through fresh reads.
                Effect.flatMap((page) =>
                  page !== null && page.events.length === 0 && !page.gap
                    ? Effect.never
                    : Effect.succeed({ _tag: "Events" as const, page }),
                ),
              ),
            );
            if (update._tag === "Detail") {
              detail = update.detail;
              if (detail !== null) resetCursor(detail);
              page = detail === null ? null : yield* passiveEvents(home, name, cursor, 1);
            } else {
              page = update.page;
              detail = page === null ? null : yield* passiveDetail(home, name);
              if (detail !== null && resetCursor(detail))
                page = yield* passiveEvents(home, name, cursor, 1);
            }
          } else {
            detail = yield* passiveDetail(home, name);
            if (detail !== null) resetCursor(detail);
            page = detail === null ? null : yield* passiveEvents(home, name, cursor, 1);
          }
          if (detail !== null) {
            if (page === null)
              return yield* new DaemonUnavailable({
                detail: "Daemon events unavailable; reconnect.",
              });
            cursor = page.next;
            draining = page.events.length === 100;
            last = detail;
            delay = 0;
            backoff = RECONNECT_INITIAL_MS;
            savedContent = null;
            return {
              _tag: "Live",
              detail,
              events: page.events,
              gap: page.gap,
              receivedAt: yield* Clock.currentTimeMillis,
            };
          }
          live = false;
          watch.incompatible();
          reason = "outdated";
        }
        const detail = yield* diskDetail(home, name);
        delay = SAVED_PROBE_MS;
        const receivedAt = yield* Clock.currentTimeMillis;
        if (detail === null) {
          if (savedContent === "archived") return null;
          savedContent = "archived";
          return { _tag: "Archived", receivedAt };
        }
        resetCursor(detail);
        const page = yield* Store.readEvents(detail.record.runDir, cursor);
        cursor = page.next;
        last = detail;
        if (page.events.length === 100) delay = 0;
        const content = JSON.stringify({ reason, detail });
        if (content === savedContent && page.events.length === 0 && !page.gap) return null;
        savedContent = content;
        return {
          _tag: "Saved",
          reason,
          detail,
          events: page.events,
          gap: page.gap,
          receivedAt,
          nextProbeAt: receivedAt + SAVED_PROBE_MS,
        };
      }).pipe(
        Effect.catchTag("RunNotFound", () =>
          Effect.gen(function* () {
            delay = SAVED_PROBE_MS;
            live = false;
            if (savedContent === "archived") return null;
            savedContent = "archived";
            return { _tag: "Archived" as const, receivedAt: yield* Clock.currentTimeMillis };
          }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          live = false;
          savedContent = null;
          delay = backoff;
          backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
          return Effect.gen(function* () {
            yield* (
              Cause.hasDies(cause)
                ? Effect.logError("monitor.detail.reconnecting")
                : Effect.logDebug("monitor.detail.reconnecting")
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
