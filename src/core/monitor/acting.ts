/**
 * The monitor's acting connection. Opening it holds one active daemon socket for the
 * lifetime of its scope, which keeps the daemon alive while the user is acting. It never
 * starts, replaces or upgrades a daemon: with none running, or one from another build,
 * opening fails and the monitor stays watching.
 */
import type { Effect, FileSystem, Path, Scope } from "effect";
import type { DaemonSockets } from "../../daemon/sockets";
import type { AppError } from "../../errors";
import type { Host } from "../../services/host";
import type { ActIntent } from "./act";

/** The answer and defer intents a session can send. */
export type SendableIntent = Extract<ActIntent, { kind: "answer" | "defer" }>;

export interface ActingSession {
  /**
   * Sends one answer or defer and returns the outcome line the monitor shows.
   *
   * @throws {RunConflict} When the question was already resolved (an answer uses `expectOpen`).
   * @throws {DaemonUnavailable} When the daemon closed or refused the request.
   */
  readonly send: (
    intent: SendableIntent,
  ) => Effect.Effect<string, AppError, FileSystem.FileSystem | Path.Path | DaemonSockets>;
}

/**
 * Opens the acting connection for the enclosing scope.
 *
 * @throws {DaemonUnavailable} When no daemon is running or its build differs from this CLI's.
 */
export const openActing = (
  _home: string,
): Effect.Effect<
  ActingSession,
  AppError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | DaemonSockets | Host
> => {
  throw new Error("not implemented");
};
