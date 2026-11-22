/**
 * Decodes one Codex app-server notification into the provider contract's `Inbound`.
 *
 * Pure: the caller owns the per-session `CodexTurnItems` and passes it in and back out, so
 * the turn's hand-off can be chosen from the items completed before `turn/completed`. A
 * notification that decodes only partly or not at all still yields what it can, plus a
 * `DecodeIssue`, so a Codex schema change degrades to a warning instead of a stuck run.
 */
import { Result, Schema } from "effect";
import * as Codex from "../../schemas/codex";
import type { Inbound, ProviderEvent, SessionId, TurnId } from "../contract";
import type { RpcNotification } from "../jsonrpc";
import { completedItemEvent, pickHandoff, startedItemKind } from "./events-items";

export { outputTail, pickHandoff } from "./events-items";

/** The items a session's current turn has completed so far, oldest first. */
export interface CodexTurnItems {
  readonly items: readonly Codex.ThreadItem[];
}

/** What one notification produced: the routed events and the session's updated items. */
export interface DecodedNotification {
  readonly inbound: Inbound;
  readonly items: CodexTurnItems;
}

/** Notifications that only show the agent is busy; they refresh the activity clock. */
const ACTIVITY_METHODS: ReadonlySet<string> = new Set([
  "item/commandExecution/outputDelta",
  "turn/moderationMetadata",
  "turn/diff/updated",
]);

const SessionEnvelope = Schema.Struct({ threadId: Schema.String });
const TurnEnvelope = Schema.Struct({ turnId: Schema.String });

const decodeTurn = Schema.decodeUnknownResult(Codex.TurnNotification);
const decodeTurnMinimal = Schema.decodeUnknownResult(Codex.TurnNotificationMinimal);
const decodeItem = Schema.decodeUnknownResult(Codex.ItemNotification);
const decodeItemMinimal = Schema.decodeUnknownResult(Codex.ItemNotificationMinimal);
const decodeHook = Schema.decodeUnknownResult(Codex.HookNotification);
const decodeTokenUsage = Schema.decodeUnknownResult(Codex.TokenUsageNotification);
const decodeError = Schema.decodeUnknownResult(Codex.ErrorNotification);
const decodeMcpStartup = Schema.decodeUnknownResult(Codex.McpStartupNotification);
const decodeSession = Schema.decodeUnknownResult(SessionEnvelope);
const decodeTurnId = Schema.decodeUnknownResult(TurnEnvelope);

/** The fields a turn notification needs, from a full or a minimal decode. */
interface TurnParams {
  readonly id: TurnId;
  readonly status: string;
  readonly error: Codex.TurnError | null;
  readonly items: readonly Codex.ThreadItem[];
}

function sessionOf(params: unknown): SessionId | null {
  const envelope = decodeSession(params);
  return Result.isSuccess(envelope) ? envelope.success.threadId : null;
}

function turnOf(params: unknown): TurnId | null {
  const envelope = decodeTurnId(params);
  return Result.isSuccess(envelope) ? envelope.success.turnId : null;
}

function invalid(method: string, params: unknown): ProviderEvent[] {
  return [{ _tag: "DecodeIssue", turn: turnOf(params), method, issue: "invalid" }];
}

// Unknown statuses count as failures; `inProgress` on a completed turn ends it like
// `completed`, as the supervisor treated it before.
function completedStatus(status: string): "completed" | "interrupted" | "failed" {
  if (status === "completed" || status === "inProgress") return "completed";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function turnEvent(method: string, turn: TurnParams, items: CodexTurnItems): ProviderEvent {
  if (method === Codex.Method.turnStarted) return { _tag: "TurnStarted", turn: turn.id };
  return {
    _tag: "TurnCompleted",
    turn: turn.id,
    status: completedStatus(turn.status),
    failure: turn.error,
    handoff: pickHandoff([...items.items, ...turn.items]),
  };
}

function turnEvents(method: string, params: unknown, items: CodexTurnItems): ProviderEvent[] {
  const full = decodeTurn(params);
  if (Result.isSuccess(full)) return [turnEvent(method, full.success.turn, items)];
  const minimal = decodeTurnMinimal(params);
  if (Result.isFailure(minimal)) return invalid(method, params);
  const turn = { ...minimal.success.turn, error: null, items: [] };
  return [
    { _tag: "DecodeIssue", turn: turn.id, method, issue: "minimal" },
    turnEvent(method, turn, items),
  ];
}

// The kind comes from the minimal envelope so hook enforcement still sees a command when
// the rest of the item no longer decodes.
function itemStartedEvents(method: string, params: unknown): ProviderEvent[] {
  const envelope = decodeItemMinimal(params);
  if (Result.isFailure(envelope)) return invalid(method, params);
  const { turnId, item } = envelope.success;
  const full = decodeItem(params);
  const command =
    Result.isSuccess(full) && Schema.is(Codex.CommandExecutionItem)(full.success.item)
      ? full.success.item.command
      : null;
  const started: ProviderEvent = {
    _tag: "ItemStarted",
    turn: turnId,
    id: item.id,
    kind: startedItemKind(item.type),
    type: item.type,
    command,
  };
  if (Result.isSuccess(full)) return [started];
  return [{ _tag: "DecodeIssue", turn: turnId, method, issue: "invalid" }, started];
}

function itemCompleted(
  method: string,
  params: unknown,
  items: CodexTurnItems,
): { events: ProviderEvent[]; items: CodexTurnItems } {
  const decoded = decodeItem(params);
  if (Result.isFailure(decoded)) return { events: invalid(method, params), items };
  const { turnId, item } = decoded.success;
  return { events: [completedItemEvent(turnId, item)], items: { items: [...items.items, item] } };
}

function hookEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeHook(params);
  if (Result.isFailure(decoded)) return invalid(method, params);
  const { turnId, run } = decoded.success;
  if (method === Codex.Method.hookStarted)
    return [{ _tag: "HookStarted", turn: turnId, project: run.source === "project" }];
  if (run.status !== "blocked") return [];
  const feedback = run.entries.map((entry) => entry.text).join("\n");
  return [{ _tag: "HookBlocked", turn: turnId, event: run.eventName, feedback }];
}

function tokenUsageEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeTokenUsage(params);
  if (Result.isFailure(decoded)) return invalid(method, params);
  const total = decoded.success.tokenUsage.total;
  const totals = {
    input: total.inputTokens,
    cachedInput: total.cachedInputTokens,
    output: total.outputTokens,
    reasoningOutput: total.reasoningOutputTokens,
  };
  return [{ _tag: "TokenUsage", turn: decoded.success.turnId, totals }];
}

// A terminal error arrives again as the failed turn's `error`, so only retries are events.
function errorEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeError(params);
  if (Result.isFailure(decoded)) return invalid(method, params);
  const { turnId, error, willRetry } = decoded.success;
  return willRetry ? [{ _tag: "Retrying", turn: turnId, message: error.message }] : [];
}

function mcpStartupEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeMcpStartup(params);
  if (Result.isFailure(decoded)) return invalid(method, params);
  const { name, status, error } = decoded.success;
  return status === "failed" ? [{ _tag: "McpStartupFailed", turn: null, server: name, error }] : [];
}

function isActivity(method: string): boolean {
  return method.endsWith("/delta") || ACTIVITY_METHODS.has(method);
}

function methodEvents(method: string, params: unknown): ProviderEvent[] {
  switch (method) {
    case Codex.Method.hookStarted:
    case Codex.Method.hookCompleted:
      return hookEvents(method, params);
    case Codex.Method.tokenUsageUpdated:
      return tokenUsageEvents(method, params);
    case Codex.Method.error:
      return errorEvents(method, params);
    case Codex.Method.mcpStartupStatus:
      return mcpStartupEvents(method, params);
    case Codex.Method.itemStarted:
      return itemStartedEvents(method, params);
  }
  if (isActivity(method)) return [{ _tag: "Activity", turn: turnOf(params) }];
  return [{ _tag: "Unrecognized", turn: turnOf(params), method }];
}

function sessionItemEvents(
  method: string,
  params: unknown,
  items: CodexTurnItems,
): { events: ProviderEvent[]; items: CodexTurnItems } {
  if (method === Codex.Method.turnStarted)
    return { events: turnEvents(method, params, items), items: { items: [] } };
  if (method === Codex.Method.turnCompleted)
    return { events: turnEvents(method, params, items), items };
  if (method === Codex.Method.itemCompleted) return itemCompleted(method, params, items);
  return { events: methodEvents(method, params), items };
}

/**
 * Decodes one notification into an `Inbound` for its session (the params' `threadId`, else
 * null) and the session's updated items: `turn/started` clears them and each completed item
 * is appended. Never fails; undecodable params become `DecodeIssue` events.
 */
export function decodeNotification(
  message: RpcNotification,
  items: CodexTurnItems,
): DecodedNotification {
  const decoded = sessionItemEvents(message.method, message.params, items);
  return {
    inbound: {
      session: sessionOf(message.params),
      method: message.method,
      raw: message,
      events: decoded.events,
    },
    items: decoded.items,
  };
}
