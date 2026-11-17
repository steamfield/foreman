/**
 * The monitor's acting connection. Opening it holds one active daemon socket for the
 * lifetime of its scope, which keeps the daemon alive while the user is acting. It never
 * starts, replaces or upgrades a daemon: with none running, or one from another build,
 * opening fails and the monitor stays watching.
 */
import { Effect, type FileSystem, type Path, type Scope } from "effect";
import { activeRequest, openActive } from "../../daemon/client";
import type { DaemonSockets } from "../../daemon/sockets";
import type { AppError } from "../../errors";
import { Host } from "../../services/host";
import type { ActIntent } from "./act";

/** The answer and defer intents a session can send. */
export type SendableIntent = Extract<ActIntent, { kind: "answer" | "defer" }>;

/** An active daemon connection and the answer and defer requests it can send. */
export interface ActingSession {
  /** Completes when the held socket ends, including daemon shutdown or a transport failure. */
  readonly closed: Effect.Effect<void>;
  /**
   * Sends one answer or defer and returns the outcome line the monitor shows.
   *
   * @throws {RunConflict} When the question was already resolved (an answer uses `expectOpen`).
   * @throws {RunNotFound} When the run or question no longer exists.
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
  home: string,
): Effect.Effect<
  ActingSession,
  AppError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | DaemonSockets | Host
> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const connection = yield* openActive(home);
    const send = Effect.fn("monitor.acting.send")(function* (intent: SendableIntent) {
      yield* activeRequest(
        home,
        intent.kind === "answer"
          ? {
              _tag: "Answer",
              name: intent.name,
              question: intent.question,
              text: intent.text,
              expectOpen: true,
            }
          : { _tag: "Defer", name: intent.name, question: intent.question },
      ).pipe(Effect.provideService(Host, host));
      return intent.kind === "answer"
        ? `answered ${intent.name} ${intent.question} · ${new TextEncoder().encode(intent.text).length} bytes`
        : `deferred ${intent.name} ${intent.question}`;
    });
    return { ...connection, send };
  });
