/**
 * The per-session turn state of an agy connection, as pure functions: the outstanding prompts
 * and their turn id, the agent message buffer the commentary and hand-off come from, a
 * permission refusal that fails the turn, and the session's token totals.
 *
 * ACP has no turn messages: a turn starts when foreman sends `session/prompt` and ends when
 * the last outstanding prompt replies.
 */
import { Schema } from "effect";
import * as Acp from "../../schemas/acp";
import type { TokenTotals, TurnKind } from "../../schemas/daemon";
import type { Access } from "../../schemas/provider";
import type { ProviderEvent, TurnId, TurnRequest } from "../contract";
import type { RpcError } from "../jsonrpc";
import { mentionsAuth, mismatchDetail, SIGNED_OUT } from "./launch";

/** The agent message text of the current turn. */
export interface TurnMessages {
  /** Everything the agent said this turn. */
  readonly all: string;
  /** What it said since the turn's last tool call started (all of it before the first). */
  readonly sinceToolCall: string;
  /**
   * A merged prompt replied, so the next text starts another answer and is set apart from the
   * text before it.
   */
  readonly answerEnded: boolean;
}

/** What separates the answers of a turn's merged prompts. */
const ANSWER_SEPARATOR = "\n\n";

/** One session's turn state. */
export interface AgyTurnState {
  readonly access: Access;
  readonly turnKind: TurnKind;
  /** The turn of the latest prompt; meaningful only while a prompt is outstanding. */
  readonly turn: TurnId | null;
  readonly outstanding: number;
  readonly messages: TurnMessages;
  /**
   * The run failure recorded this turn: foreman refused a permission, or a prompt that didn't
   * end the turn (one a steer merged) failed.
   */
  readonly refusal: string | null;
  /** Token totals summed over every prompt reply of the session. */
  readonly totals: TokenTotals;
}

/** How a `session/prompt` request ended, reduced to what decides the turn's outcome. */
export type PromptOutcome =
  | {
      readonly _tag: "Replied";
      readonly stopReason: string;
      readonly usage: TokenTotals | null;
    }
  /** agy answered with an error, or a reply foreman can't read; `message` is the failure. */
  | { readonly _tag: "Failed"; readonly message: string };

const NO_MESSAGES: TurnMessages = { all: "", sinceToolCall: "", answerEnded: false };
const NO_TOKENS: TokenTotals = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };

/**
 * The state of a session just opened or resumed with the run's access. `totals` seeds the
 * token sum, so a resumed session continues the run's recorded total.
 */
export function openedSession(access: Access, totals: TokenTotals = NO_TOKENS): AgyTurnState {
  return {
    access,
    turnKind: "start",
    turn: null,
    outstanding: 0,
    messages: NO_MESSAGES,
    refusal: null,
    totals,
  };
}

/** agy's turn id for a foreman turn number. */
export const turnIdFor = (turn: number): TurnId => `t${turn}`;

/** Starts a turn: one more outstanding prompt, with a fresh message buffer and no refusal. */
export function beginTurn(state: AgyTurnState, request: TurnRequest): AgyTurnState {
  return {
    ...state,
    access: request.settings.access,
    turnKind: request.kind,
    turn: turnIdFor(request.turn),
    outstanding: state.outstanding + 1,
    messages: NO_MESSAGES,
    refusal: null,
  };
}

/**
 * Adds a steer's prompt to the running turn: one more outstanding prompt, keeping the turn id,
 * its message buffer and any refusal, since agy merges the prompt into the same turn.
 * @throws Never.
 */
export function beginSteer(state: AgyTurnState): AgyTurnState {
  return { ...state, outstanding: state.outstanding + 1 };
}

/**
 * Whether a steer for `turn` can join the session's running turn: a prompt is outstanding and
 * it belongs to that turn. Once the last reply is applied the turn's completion is queued, so
 * nothing outstanding means the steer would start a new agy turn foreman isn't tracking.
 * @throws Never.
 */
export function acceptsSteer(state: AgyTurnState, turn: TurnId): boolean {
  return state.outstanding > 0 && state.turn === turn;
}

/** The turn events belong to: the outstanding prompt's, or null when none is outstanding. */
export function activeTurn(state: AgyTurnState): TurnId | null {
  return state.outstanding > 0 ? state.turn : null;
}

/**
 * Adds a chunk of agent message text to the turn's buffers. The first chunk after a merged
 * prompt's reply is separated from earlier text, so two answers don't run together.
 */
export function appendMessage(state: AgyTurnState, text: string): AgyTurnState {
  const { all, sinceToolCall, answerEnded } = state.messages;
  const join = (buffer: string) =>
    answerEnded && buffer !== "" ? buffer + ANSWER_SEPARATOR + text : buffer + text;
  return {
    ...state,
    messages: { all: join(all), sinceToolCall: join(sinceToolCall), answerEnded: false },
  };
}

/**
 * Marks the start of a tool call. Returns the text said since the previous one as commentary,
 * or null when there was none.
 */
export function startToolCall(state: AgyTurnState): {
  readonly state: AgyTurnState;
  readonly commentary: string | null;
} {
  const commentary = state.messages.sinceToolCall === "" ? null : state.messages.sinceToolCall;
  return { state: { ...state, messages: { ...state.messages, sinceToolCall: "" } }, commentary };
}

/** Records the failure a refused permission causes; agy ends the turn right after. */
export function recordRefusal(state: AgyTurnState, message: string): AgyTurnState {
  return { ...state, refusal: message };
}

/**
 * Forgets the session's outstanding prompts after agy failed to answer a cancel, so the next
 * prompt's reply completes its turn.
 */
export function abandonPrompts(state: AgyTurnState): AgyTurnState {
  return { ...state, outstanding: 0 };
}

/** The hand-off: the text after the turn's last tool call, else all of it; null when silent. */
export function handoffText(messages: TurnMessages): string | null {
  if (messages.sinceToolCall !== "") return messages.sinceToolCall;
  return messages.all === "" ? null : messages.all;
}

function addTokens(totals: TokenTotals, usage: TokenTotals | null): TokenTotals {
  if (usage === null) return totals;
  return {
    input: totals.input + usage.input,
    cachedInput: totals.cachedInput + usage.cachedInput,
    output: totals.output + usage.output,
    reasoningOutput: totals.reasoningOutput + usage.reasoningOutput,
  };
}

const STOP_STATUS: Readonly<Record<string, "completed" | "interrupted">> = {
  end_turn: "completed",
  cancelled: "interrupted",
};

function turnOutcome(
  state: AgyTurnState,
  outcome: PromptOutcome,
): { status: "completed" | "interrupted" | "failed"; failure: string | null } {
  if (state.refusal !== null) return { status: "failed", failure: state.refusal };
  if (outcome._tag === "Failed") return { status: "failed", failure: outcome.message };
  const status = Object.hasOwn(STOP_STATUS, outcome.stopReason)
    ? STOP_STATUS[outcome.stopReason]
    : undefined;
  if (status !== undefined) return { status, failure: null };
  return { status: "failed", failure: `agy stopped the turn: ${outcome.stopReason}` };
}

/**
 * Applies a reply that doesn't end the turn: a failure is kept for the turn's outcome, and the
 * next text is marked as another answer.
 */
function mergeReply(state: AgyTurnState, outcome: PromptOutcome): AgyTurnState {
  const messages = { ...state.messages, answerEnded: state.messages.all !== "" };
  if (outcome._tag !== "Failed" || state.refusal !== null) return { ...state, messages };
  return { ...state, messages, refusal: outcome.message };
}

/**
 * Applies a prompt's reply. Usage always counts; the turn completes only when no other prompt
 * is outstanding, with the hand-off message, the session's token totals and the outcome. A
 * failure recorded by any of the turn's prompts fails it.
 */
export function finishPrompt(
  state: AgyTurnState,
  outcome: PromptOutcome,
): { readonly state: AgyTurnState; readonly events: readonly ProviderEvent[] } {
  const usage = outcome._tag === "Replied" ? outcome.usage : null;
  const next: AgyTurnState = {
    ...state,
    outstanding: Math.max(0, state.outstanding - 1),
    totals: addTokens(state.totals, usage),
  };
  const turn = state.turn;
  if (next.outstanding > 0 || turn === null)
    return { state: mergeReply(next, outcome), events: [] };
  const handoff = handoffText(state.messages);
  const { status, failure } = turnOutcome(state, outcome);
  const events: ProviderEvent[] = [];
  if (handoff !== null)
    events.push({ _tag: "AgentMessage", turn, text: handoff, phase: "final_answer" });
  events.push({ _tag: "TokenUsage", turn, totals: next.totals });
  events.push({
    _tag: "TurnCompleted",
    turn,
    status,
    failure: failure === null ? null : { message: failure, codexErrorInfo: null },
    handoff,
  });
  return { state: next, events };
}

/**
 * Converts a reply's ACP usage into foreman's token totals. agy counts cache reads and writes
 * apart from `inputTokens`; foreman's input, like Codex's, includes them.
 */
export function tokensOf(usage: Acp.PromptUsage): TokenTotals {
  return {
    input: usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
    cachedInput: usage.cachedReadTokens ?? 0,
    output: usage.outputTokens,
    reasoningOutput: usage.thoughtTokens ?? 0,
  };
}

/**
 * Reads a `session/prompt` reply into the outcome that ends the turn: agy's stop reason and
 * usage, or the failure for an error reply or one that doesn't decode.
 */
export function promptOutcome(result: unknown, error: RpcError | null): PromptOutcome {
  if (error !== null) {
    const message = mentionsAuth(error.message)
      ? SIGNED_OUT
      : `agy refused the turn: ${error.message}`;
    return { _tag: "Failed", message };
  }
  const decoded = Schema.decodeUnknownOption(Acp.PromptResult)(result);
  if (decoded._tag === "None")
    return { _tag: "Failed", message: mismatchDetail(Acp.Method.prompt) };
  const { stopReason, usage } = decoded.value;
  return { _tag: "Replied", stopReason, usage: usage === undefined ? null : tokensOf(usage) };
}
