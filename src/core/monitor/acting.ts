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
import type { DaemonRequestBody, DaemonResult } from "../../schemas/daemon";
import { Host } from "../../services/host";
import type { ActIntent } from "./act";

/** The mutation intents an acting session can send. */
export type SendableIntent = Exclude<ActIntent, { kind: "enter-acting" | "leave-acting" }>;

/** An active daemon connection and the monitor actions it can send. */
export interface ActingSession {
  /** Completes when the held socket ends, including daemon shutdown or a transport failure. */
  readonly closed: Effect.Effect<void>;
  /**
   * Sends one action and returns the outcome line the monitor shows.
   *
   * @throws {AppError} When the daemon rejects the action or its connection fails.
   */
  readonly send: (
    intent: SendableIntent,
  ) => Effect.Effect<string, AppError, FileSystem.FileSystem | Path.Path | DaemonSockets>;
}

const requestFor = (intent: SendableIntent): DaemonRequestBody => {
  const name = intent.name;
  if (intent.kind === "answer")
    return {
      _tag: "Answer",
      name,
      question: intent.question,
      text: intent.text,
      expectOpen: true,
      source: "monitor",
    };
  if (intent.kind === "defer")
    return { _tag: "Defer", name, question: intent.question, source: "monitor" };
  if (intent.kind === "steer") return { _tag: "Steer", name, message: intent.text };
  if (intent.kind === "followup") return { _tag: "Followup", name, message: intent.text };
  if (intent.kind === "interrupt") return { _tag: "Interrupt", name, source: "monitor" };
  return { _tag: "Archive", name, keepWorktree: intent.keepWorktree };
};

const outcome = (intent: SendableIntent, reply: DaemonResult): string => {
  if (intent.kind === "answer")
    return `answered ${intent.name} ${intent.question} · ${new TextEncoder().encode(intent.text).length} bytes`;
  if (intent.kind === "defer") return `deferred ${intent.name} ${intent.question}`;
  if (intent.kind === "steer")
    return `steered ${intent.name} · ${new TextEncoder().encode(intent.text).length} bytes`;
  if (intent.kind === "followup")
    return `followed up ${intent.name}${"turn" in reply && typeof reply.turn === "number" ? ` · turn ${reply.turn}` : ""}`;
  if (intent.kind === "interrupt") return `interrupted ${intent.name}`;
  return `archived ${intent.name}${intent.keepWorktree ? " · worktree kept" : ""}`;
};

/**
 * Opens the acting connection for the enclosing scope.
 *
 * @throws {DaemonUnavailable} When no daemon is running or its build differs from this CLI's.
 * @throws {AppError} When the daemon connection cannot be opened or validated.
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
      const reply = yield* activeRequest(home, requestFor(intent)).pipe(
        Effect.provideService(Host, host),
      );
      return outcome(intent, reply);
    });
    return { ...connection, send };
  });
