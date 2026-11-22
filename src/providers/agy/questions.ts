/**
 * Questions on agy: the `ask_orchestrator` MCP bridge each session gets, and the bookkeeping
 * for calls the connection holds until the supervisor answers them.
 * docs/rfcs/0002-providers.md "Questions on agy" is the design.
 */
import type { Deferred, Effect } from "effect";
import type { QuestionCancelled, QuestionRefused } from "../contract";

/** One stdio MCP server entry in `session/new` or `session/resume` `mcpServers`. */
export interface StdioMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export interface BridgeOptions {
  /** foreman's own command line (Host.executable): the binary, then any script it runs. */
  readonly executable: readonly string[];
  /** The run whose questions the bridge forwards. */
  readonly run: string;
  /** FOREMAN_HOME, so the bridge reaches this daemon's socket. */
  readonly home: string;
}

/**
 * The `mcpServers` entry that runs `foreman mcp-question --run <run>` with FOREMAN_HOME set.
 * Pure.
 */
export function questionBridge(options: BridgeOptions): StdioMcpServer {
  throw new Error(`not implemented: questionBridge(${options.run})`);
}

/** How a held call ends: the answer text, or the refusal or cancellation the agent sees. */
export type HeldOutcome = Deferred.Deferred<string, QuestionRefused | QuestionCancelled>;

/** The calls one connection holds, by callId. */
export interface HeldCalls {
  /** Registers a call and returns the Deferred its QuestionCall completes. */
  readonly hold: (callId: string) => Effect.Effect<HeldOutcome>;
  /** Forgets a call once its outcome was delivered or its asker went away. */
  readonly release: (callId: string) => Effect.Effect<void>;
  /** The outcome of a call still held, if any. */
  readonly get: (callId: string) => HeldOutcome | undefined;
}

/** Makes an empty set of held calls for one connection. */
export function makeHeldCalls(): HeldCalls {
  throw new Error("not implemented: makeHeldCalls");
}
