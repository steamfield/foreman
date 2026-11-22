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
  /** The turn the items belong to: set by `turn/started`, null before any turn is seen. */
  readonly turn: TurnId | null;
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
const ItemIdEnvelope = Schema.Struct({ item: Schema.Struct({ id: Schema.String }) });

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
const decodeItemId = Schema.decodeUnknownResult(ItemIdEnvelope);
const decodeItemKind = Schema.decodeUnknownResult(Codex.ItemKind);

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

function itemIdOf(params: unknown): string {
  const envelope = decodeItemId(params);
  return Result.isSuccess(envelope) ? envelope.success.item.id : "";
}

// An undecodable message adopts no turn and is never filtered as stale, and it is still
// recorded as an `Other` event, so both events carry no turn.
function invalid(method: string): ProviderEvent[] {
  return [
    { _tag: "DecodeIssue", turn: null, method, issue: "invalid" },
    { _tag: "Unrecognized", turn: null, method },
  ];
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

/** A turn notification decoded fully or minimally, with the issue events the decode raised. */
interface DecodedTurn {
  readonly turn: TurnParams | null;
  readonly issues: ProviderEvent[];
}

function decodeTurnParams(method: string, params: unknown): DecodedTurn {
  const full = decodeTurn(params);
  if (Result.isSuccess(full)) return { turn: full.success.turn, issues: [] };
  const minimal = decodeTurnMinimal(params);
  if (Result.isFailure(minimal)) return { turn: null, issues: invalid(method) };
  const turn = { ...minimal.success.turn, error: null, items: [] };
  return { turn, issues: [{ _tag: "DecodeIssue", turn: turn.id, method, issue: "minimal" }] };
}

function turnEvents(method: string, decoded: DecodedTurn, items: CodexTurnItems) {
  if (decoded.turn === null) return decoded.issues;
  return [...decoded.issues, turnEvent(method, decoded.turn, items)];
}

function turnStarted(method: string, params: unknown): SessionEvents {
  const decoded = decodeTurnParams(method, params);
  const items = { turn: decoded.turn?.id ?? null, items: [] };
  return { events: turnEvents(method, decoded, items), items };
}

// Hook enforcement fails closed: a command start counts even when its turn and id are lost.
function commandStartWithoutEnvelope(method: string, params: unknown): ProviderEvent[] {
  const kind = decodeItemKind(params);
  if (Result.isFailure(kind) || kind.success.item.type !== "commandExecution")
    return invalid(method);
  const started: ProviderEvent = {
    _tag: "ItemStarted",
    turn: turnOf(params),
    id: itemIdOf(params),
    kind: "command",
    type: kind.success.item.type,
    command: null,
  };
  return [...invalid(method), started];
}

// The kind comes from the minimal envelope so hook enforcement still sees a command when
// the rest of the item no longer decodes.
function itemStartedEvents(method: string, params: unknown): ProviderEvent[] {
  const envelope = decodeItemMinimal(params);
  if (Result.isFailure(envelope)) return commandStartWithoutEnvelope(method, params);
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
  return [...invalid(method), started];
}

/** Events for one notification and the session's items after it. */
interface SessionEvents {
  readonly events: ProviderEvent[];
  readonly items: CodexTurnItems;
}

// A late item from an interrupted turn must not become the next turn's hand-off, so only
// the current turn's items are kept. Before any turn/started, the first item's turn is it.
function itemCompleted(method: string, params: unknown, items: CodexTurnItems): SessionEvents {
  const decoded = decodeItem(params);
  if (Result.isFailure(decoded)) return { events: invalid(method), items };
  const { turnId, item } = decoded.success;
  const events = [completedItemEvent(turnId, item)];
  if (items.turn !== null && items.turn !== turnId) return { events, items };
  return { events, items: { turn: turnId, items: [...items.items, item] } };
}

function hookEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeHook(params);
  if (Result.isFailure(decoded)) return invalid(method);
  const { turnId, run } = decoded.success;
  if (method === Codex.Method.hookStarted)
    return [{ _tag: "HookStarted", turn: turnId, project: run.source === "project" }];
  if (run.status !== "blocked") return [];
  const feedback = run.entries.map((entry) => entry.text).join("\n");
  return [{ _tag: "HookBlocked", turn: turnId, event: run.eventName, feedback }];
}

function tokenUsageEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeTokenUsage(params);
  if (Result.isFailure(decoded)) return invalid(method);
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
  if (Result.isFailure(decoded)) return invalid(method);
  const { turnId, error, willRetry } = decoded.success;
  return willRetry ? [{ _tag: "Retrying", turn: turnId, message: error.message }] : [];
}

function mcpStartupEvents(method: string, params: unknown): ProviderEvent[] {
  const decoded = decodeMcpStartup(params);
  if (Result.isFailure(decoded)) return invalid(method);
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
  // Deltas and unknown methods adopt no turn and are never filtered as stale.
  if (isActivity(method)) return [{ _tag: "Activity", turn: null }];
  return [{ _tag: "Unrecognized", turn: null, method }];
}

function sessionItemEvents(method: string, params: unknown, items: CodexTurnItems): SessionEvents {
  if (method === Codex.Method.turnStarted) return turnStarted(method, params);
  if (method === Codex.Method.turnCompleted)
    return { events: turnEvents(method, decodeTurnParams(method, params), items), items };
  if (method === Codex.Method.itemCompleted) return itemCompleted(method, params, items);
  return { events: methodEvents(method, params), items };
}

/**
 * Decodes one notification into an `Inbound` for its session (the params' `threadId`, else
 * null) and the session's updated items: `turn/started` clears them and records its turn, and
 * each completed item of that turn is appended. Never fails; undecodable params become `DecodeIssue` events.
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
