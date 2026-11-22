/**
 * Questions on agy: the `ask_orchestrator` MCP bridge each session gets, and holding a bridge
 * call until the supervisor answers, refuses or cancels it. docs/rfcs/0002-providers.md
 * "Questions on agy" is the design.
 */
import { Deferred, Effect, Queue } from "effect";
import { AgyUnavailable } from "../../errors";
import {
  type ExternalQuestion,
  type Inbound,
  type QuestionCall,
  QuestionCancelled,
  QuestionRefused,
  type SessionId,
  type TurnId,
} from "../contract";
import { ASK_TOOL } from "./events";
import type { BridgeFor, Live } from "./live";

/** The refusal for a question asked while the session has no prompt outstanding. */
export const TURN_NOT_ACTIVE = "turn is no longer active";

const CONNECTION_CLOSED =
  "the agy connection closed before the question reached foreman; the run will be marked lost.";
const NO_EXECUTABLE =
  "foreman doesn't know its own executable path, so agy can't launch the question bridge; reinstall foreman and retry.";

/** One stdio MCP server entry in `session/new` or `session/resume` `mcpServers`. */
export interface StdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

/** foreman's own command line (Host.executable): the binary, then any script it runs. */
export type Executable = readonly [string, ...string[]];

/** What the bridge entry for one run needs. */
export interface BridgeOptions {
  readonly executable: Executable;
  /** The run whose questions the bridge forwards. */
  readonly run: string;
  /** FOREMAN_HOME, so the bridge reaches this daemon's socket. */
  readonly home: string;
}

/**
 * The `mcpServers` entry that runs `foreman mcp-question --run <run>` with FOREMAN_HOME set.
 * Pure.
 * @throws Never.
 */
export function questionBridge(options: BridgeOptions): StdioMcpServer {
  const [command, ...prefix] = options.executable;
  return {
    name: "foreman",
    command,
    args: [...prefix, "mcp-question", "--run", options.run],
    env: [{ name: "FOREMAN_HOME", value: options.home }],
  };
}

/**
 * The bridge entry builder for a connection, from foreman's command line and home.
 * @throws {AgyUnavailable} When the command line is empty, so agy couldn't launch the bridge.
 */
export const bridgeFor = (executable: readonly string[], home: string) => {
  const [command, ...prefix] = executable;
  if (command === undefined) return Effect.fail(new AgyUnavailable({ detail: NO_EXECUTABLE }));
  const bridge: BridgeFor = (run) =>
    questionBridge({ executable: [command, ...prefix], run, home });
  return Effect.succeed(bridge);
};

/** How a held call ends: the answer text, or the refusal or cancellation the agent sees. */
export type HeldOutcome = Deferred.Deferred<string, QuestionRefused | QuestionCancelled>;

/** The calls one connection holds, by callId. */
export type HeldCalls = Map<string, HeldOutcome>;

/**
 * The turn of the session's outstanding prompt, or null when none is outstanding. Pure.
 * @throws Never.
 */
export function outstandingTurn(live: Live, session: SessionId): TurnId | null {
  if (![...live.prompts.values()].includes(session)) return null;
  return live.sessions.get(session)?.turn.turn ?? null;
}

/** The QuestionCall the supervisor sees; each of its outcomes completes `outcome`. */
function questionCall(
  session: SessionId,
  turn: TurnId,
  question: ExternalQuestion,
  outcome: HeldOutcome,
): QuestionCall {
  return {
    session,
    turn,
    callId: question.callId,
    question: question.question,
    kind: question.kind,
    raw: question.raw,
    respond: (text) => Deferred.succeed(outcome, text).pipe(Effect.asVoid),
    reject: (reason) => Deferred.fail(outcome, new QuestionRefused({ reason })).pipe(Effect.asVoid),
    cancel: Deferred.fail(outcome, new QuestionCancelled()).pipe(Effect.asVoid),
  };
}

/** The message that tells the supervisor a held call's asker went away. */
function abandoned(session: SessionId, turn: TurnId, callId: string): Inbound {
  return {
    session,
    method: ASK_TOOL,
    raw: null,
    events: [{ _tag: "QuestionAbandoned", turn, callId }],
  };
}

/** Reports the call abandoned unless the supervisor already settled it. */
const abandon = Effect.fnUntraced(function* (
  live: Live,
  session: SessionId,
  turn: TurnId,
  question: ExternalQuestion,
  outcome: HeldOutcome,
) {
  // Settling the outcome first means a racing respond or a second interrupt changes nothing.
  const settled = yield* Deferred.fail(outcome, new QuestionCancelled());
  if (settled) yield* Queue.offer(live.inbound, abandoned(session, turn, question.callId));
});

/**
 * Hands a bridge question to the supervisor as a QuestionCall stamped with the session's
 * outstanding turn, and waits for its outcome. When the waiting fiber is interrupted first
 * (the bridge's socket closed), reports QuestionAbandoned on `inbound`.
 * @throws {QuestionRefused} When the session has no prompt outstanding, the callId is already
 * held, or the supervisor rejects the call.
 * @throws {QuestionCancelled} When the supervisor cancels the question.
 * @throws {AgyUnavailable} When the connection closed before the call could be handed over.
 */
export const askQuestion = (live: Live, session: SessionId, question: ExternalQuestion) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const turn = outstandingTurn(live, session);
      if (turn === null) return yield* new QuestionRefused({ reason: TURN_NOT_ACTIVE });
      if (live.held.has(question.callId))
        return yield* new QuestionRefused({
          reason: `question ${question.callId} is already waiting for an answer; wait for it instead of asking again.`,
        });
      const outcome: HeldOutcome = yield* Deferred.make<
        string,
        QuestionRefused | QuestionCancelled
      >();
      live.held.set(question.callId, outcome);
      return yield* Effect.gen(function* () {
        const call = questionCall(session, turn, question, outcome);
        if (!(yield* Queue.offer(live.questions, call)))
          return yield* new AgyUnavailable({ detail: CONNECTION_CLOSED });
        return yield* restore(Deferred.await(outcome)).pipe(
          Effect.onInterrupt(() => abandon(live, session, turn, question, outcome)),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => live.held.delete(question.callId))));
    }),
  );
