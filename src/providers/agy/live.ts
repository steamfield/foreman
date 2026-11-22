/**
 * The state one live agy connection shares between its session flow (connection.ts) and its
 * permission answers (permission-requests.ts). Only the connection's message reader and the
 * requests the supervisor makes touch it, one at a time.
 */
import type { Cause, Deferred, Queue } from "effect";
import type { AgyUnavailable } from "../../errors";
import type { Inbound, SessionId } from "../contract";
import type { Channel, RpcId } from "../jsonrpc";
import type { AgySessionState } from "./events";

/** The ordered JSON-RPC channel to `agy acp`. */
export type AgyChannel = Channel<AgyUnavailable>;

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
}
