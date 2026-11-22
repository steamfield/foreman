/**
 * The state one live agy connection shares between its session flow (connection.ts), its
 * permission answers (permission-requests.ts) and its held questions (questions.ts). Only the
 * connection's message reader and the requests the supervisor makes touch it, one at a time.
 */
import { type Cause, type Deferred, Effect, Queue } from "effect";
import type { AgyUnavailable } from "../../errors";
import type { Inbound, QuestionCall, SessionId } from "../contract";
import type { Channel, RpcId } from "../jsonrpc";
import type { AgySessionState } from "./events";
import type { HeldCalls, StdioMcpServer } from "./questions";

/** The ordered JSON-RPC channel to `agy acp`. */
export type AgyChannel = Channel<AgyUnavailable>;

/** Builds the ask_orchestrator bridge entry for a run's session. */
export type BridgeFor = (run: string) => StdioMcpServer;

/** What every part of one live connection shares. */
export interface Live {
  readonly channel: AgyChannel;
  /** Sessions this connection opened, with their turn state and tool calls. */
  readonly sessions: Map<SessionId, AgySessionState>;
  /** The session of each `session/prompt` still awaiting its reply, by request id. */
  readonly prompts: Map<RpcId, SessionId>;
  /** Per session, an interrupt waiting for the session's prompts to reply. */
  readonly settled: Map<SessionId, Deferred.Deferred<void>>;
  /** What the supervisor reads, in wire order. */
  readonly inbound: Queue.Queue<Inbound, AgyUnavailable | Cause.Done>;
  /** Bridge questions handed to the supervisor; ends when the connection does. */
  readonly questions: Queue.Queue<QuestionCall, Cause.Done>;
  /** Bridge calls waiting for the supervisor's outcome, by callId. */
  readonly held: HeldCalls;
  readonly bridge: BridgeFor;
}

/**
 * Makes the empty shared state for a connection over `channel`.
 * @throws Never.
 */
export const makeLive = Effect.fnUntraced(function* (channel: AgyChannel, bridge: BridgeFor) {
  const live: Live = {
    channel,
    sessions: new Map(),
    prompts: new Map(),
    settled: new Map(),
    inbound: yield* Queue.unbounded<Inbound, AgyUnavailable | Cause.Done>(),
    questions: yield* Queue.unbounded<QuestionCall, Cause.Done>(),
    held: new Map(),
    bridge,
  };
  return live;
});
