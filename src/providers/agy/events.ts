/**
 * agy's `session/update` notifications as ProviderEvents, per docs/rfcs/0002-providers.md
 * "The agy adapter" events table. Pure: the caller keeps each session's state between calls.
 *
 * A tool call's later updates often repeat only its id, kind and status, so the name, title
 * and command seen first are remembered per tool call id.
 */
import { Schema } from "effect";
import * as Acp from "../../schemas/acp";
import type { Inbound, ItemSummary, ProviderEvent, SessionId, TurnId } from "../contract";
import type { RpcNotification } from "../jsonrpc";
import { outputTail } from "../output-tail";
import { type AgyTurnState, activeTurn, appendMessage, startToolCall } from "./turns";

/** What foreman remembers about one tool call. */
export interface ToolCallInfo {
  readonly kind: string;
  readonly name: string | null;
  readonly title: string | null;
  readonly command: string | null;
}

/** One session's state: its turn and the tool calls seen so far. */
export interface AgySessionState {
  readonly turn: AgyTurnState;
  readonly tools: ReadonlyMap<string, ToolCallInfo>;
  /** The worktree the session runs in, when this connection opened it. */
  readonly cwd: string | null;
}

/** The ask_orchestrator bridge's tool; its question reaches foreman through the daemon. */
export const ASK_TOOL = "mcp_foreman_ask_orchestrator";

const FILE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);
const ACTIVITY_UPDATES: ReadonlySet<string> = new Set([
  "agent_thought_chunk",
  "usage_update",
  "session_info_update",
  "config_option_update",
  "current_mode_update",
  "available_commands_update",
]);

type Applied = { readonly state: AgySessionState; readonly events: readonly ProviderEvent[] };

/** Returns the session a message names, or null when it names none. */
export function sessionOf(params: unknown): SessionId | null {
  return Schema.is(Acp.SessionEnvelope)(params) ? params.sessionId : null;
}

/**
 * Decodes one agy notification for a session foreman may know. Messages that arrive with no
 * prompt outstanding, or for a session this connection didn't open, carry no events.
 */
export function readNotification(
  message: RpcNotification,
  state: AgySessionState | undefined,
): { readonly inbound: Inbound; readonly state: AgySessionState | undefined } {
  const session = sessionOf(message.params);
  const inbound = (events: readonly ProviderEvent[]): Inbound => ({
    session,
    method: message.method,
    raw: message,
    events,
  });
  const turn = state === undefined ? null : activeTurn(state.turn);
  if (state === undefined || turn === null) return { inbound: inbound([]), state };
  if (message.method !== Acp.Method.update) {
    return { inbound: inbound([{ _tag: "Unrecognized", turn, method: message.method }]), state };
  }
  if (!Schema.is(Acp.SessionUpdate)(message.params)) {
    const issue: ProviderEvent = {
      _tag: "DecodeIssue",
      turn,
      method: message.method,
      issue: "invalid",
    };
    return { inbound: inbound([issue]), state };
  }
  const applied = applyUpdate(message.params.update, turn, state);
  return { inbound: inbound(applied.events), state: applied.state };
}

/** Maps one decoded `update` body to events for the active turn. */
function applyUpdate(
  update: { readonly sessionUpdate: string },
  turn: TurnId,
  state: AgySessionState,
): Applied {
  const kind = update.sessionUpdate;
  if (kind === "tool_call" || kind === "tool_call_update") {
    if (!Schema.is(Acp.ToolCall)(update)) return invalid(turn, state);
    return kind === "tool_call"
      ? toolCallStarted(update, turn, state)
      : toolCallUpdated(update, turn, state);
  }
  if (kind === "agent_message_chunk") {
    if (!Schema.is(Acp.MessageChunk)(update)) return invalid(turn, state);
    const text = update.content.text ?? "";
    return { state: { ...state, turn: appendMessage(state.turn, text) }, events: [activity(turn)] };
  }
  if (ACTIVITY_UPDATES.has(kind)) return { state, events: [activity(turn)] };
  return {
    state,
    events: [{ _tag: "Unrecognized", turn, method: `${Acp.Method.update}:${kind}` }],
  };
}

const activity = (turn: TurnId): ProviderEvent => ({ _tag: "Activity", turn });

function invalid(turn: TurnId, state: AgySessionState): Applied {
  return {
    state,
    events: [{ _tag: "DecodeIssue", turn, method: Acp.Method.update, issue: "invalid" }],
  };
}

/** Merges what this update says about a tool call over what earlier ones said. */
function remember(state: AgySessionState, call: Acp.ToolCall): ToolCallInfo {
  const known = state.tools.get(call.toolCallId);
  const command = call.args?.CommandLine;
  return {
    kind: call.kind ?? known?.kind ?? "other",
    name: call.name ?? known?.name ?? null,
    title: call.title ?? known?.title ?? null,
    command: typeof command === "string" ? command : (known?.command ?? call.title ?? null),
  };
}

function withTool(state: AgySessionState, id: string, info: ToolCallInfo): AgySessionState {
  return { ...state, tools: new Map(state.tools).set(id, info) };
}

function toolCallStarted(call: Acp.ToolCall, turn: TurnId, state: AgySessionState): Applied {
  const info = remember(state, call);
  const started = startToolCall(state.turn);
  const next = withTool({ ...state, turn: started.state }, call.toolCallId, info);
  const events: ProviderEvent[] = [];
  if (started.commentary !== null) {
    events.push({ _tag: "AgentMessage", turn, text: started.commentary, phase: "commentary" });
  }
  if (info.name === ASK_TOOL) return { state: next, events };
  events.push({
    _tag: "ItemStarted",
    turn,
    id: call.toolCallId,
    kind: itemKind(info.kind),
    type: info.kind,
    command: info.kind === "execute" ? info.command : null,
  });
  // agy reports a call that failed before it ran (a hook denial) as an already failed tool_call.
  if (isTerminal(call)) events.push(...completion(call, info, turn));
  return { state: next, events };
}

function toolCallUpdated(call: Acp.ToolCall, turn: TurnId, state: AgySessionState): Applied {
  const info = remember(state, call);
  const next = withTool(state, call.toolCallId, info);
  if (!isTerminal(call)) return { state: next, events: [activity(turn)] };
  return { state: next, events: completion(call, info, turn) };
}

const isTerminal = (call: Acp.ToolCall) =>
  call.status !== undefined && TERMINAL_STATUSES.has(call.status);

function itemKind(kind: string): "command" | "fileChange" | "tool" {
  if (kind === "execute") return "command";
  return FILE_KINDS.has(kind) ? "fileChange" : "tool";
}

/** The ItemCompleted for a tool call that completed or failed; none for the question tool. */
function completion(call: Acp.ToolCall, info: ToolCallInfo, turn: TurnId): ProviderEvent[] {
  if (info.name === ASK_TOOL) return [];
  return [{ _tag: "ItemCompleted", turn, item: summarize(call, info) }];
}

function summarize(call: Acp.ToolCall, info: ToolCallInfo): ItemSummary {
  const id = call.toolCallId;
  const status = call.status ?? "completed";
  if (info.kind === "execute") {
    return {
      kind: "command",
      id,
      command: info.command ?? "",
      status,
      exitCode: call.rawOutput?.exit_code ?? null,
      outputTail: outputTail(call.rawOutput?.output ?? null),
    };
  }
  if (FILE_KINDS.has(info.kind) && status === "completed") {
    return { kind: "fileChange", id, paths: changedPaths(call) };
  }
  return { kind: "tool", id, name: info.name ?? info.title ?? info.kind };
}

/** Paths from the call's diffs and locations, each once, diffs first. */
function changedPaths(call: Acp.ToolCall): string[] {
  const diffs = (call.content ?? []).filter(Schema.is(Acp.DiffContent)).map((diff) => diff.path);
  const locations = (call.locations ?? []).map((location) => location.path);
  return [...new Set([...diffs, ...locations])];
}
