import { DateTime } from "effect";
import {
  activeStates,
  type QuestionId,
  type QuestionLine,
  type RunEventBody,
  type RunState,
} from "../../schemas/daemon";

export const QUIET_AFTER_MS = 5 * 60_000;

type OpenItem = { type: string; command: string | null; startedAt: number } | null;
type TextAt = { text: string; at: number };

export const quiet = (
  state: RunState,
  openItem: OpenItem,
  lastActivityAt: number | null,
  now: number,
) =>
  state === "running" &&
  openItem?.type !== "commandExecution" &&
  lastActivityAt !== null &&
  now - lastActivityAt >= QUIET_AFTER_MS;

export const defersAt = (askedAt: number, timeoutMs: number, deferred: boolean) =>
  deferred ? null : askedAt + timeoutMs;

export function activity(input: {
  state: RunState;
  openItem: OpenItem;
  commentary: TextAt | null;
  handoff: TextAt | null;
  failure: TextAt | null;
}) {
  if (activeStates.has(input.state)) {
    if (input.openItem?.type === "commandExecution")
      return {
        kind: "command" as const,
        text: input.openItem.command ?? "",
        at: input.openItem.startedAt,
      };
    return input.commentary === null ? null : { kind: "message" as const, ...input.commentary };
  }
  if ((input.state === "failed" || input.state === "lost") && input.failure !== null)
    return { kind: "failure" as const, ...input.failure };
  return input.handoff === null ? null : { kind: "outcome" as const, ...input.handoff };
}

export interface QuestionCacheEntry {
  readonly asked: Extract<QuestionLine, { _tag: "Asked" }>;
  readonly deferred: boolean;
}

export function updateQuestion(cache: Map<QuestionId, QuestionCacheEntry>, line: QuestionLine) {
  if (line._tag === "Asked") cache.set(line.id, { asked: line, deferred: false });
  else if (line._tag === "Resolved") cache.delete(line.id);
  else {
    const previous = cache.get(line.id);
    if (previous) cache.set(line.id, { ...previous, deferred: true });
  }
}

export function handoffLine(text: string, at: number): TextAt {
  return { text: text.split(/\r?\n/, 1)[0] ?? "", at };
}

export interface TurnAttention {
  retrying: { at: number; message: string } | null;
  hooksBlocked: number;
}

export function updateTurnAttention(cache: TurnAttention, event: RunEventBody, at: number) {
  if (event._tag === "TurnStarted") {
    cache.retrying = null;
    cache.hooksBlocked = 0;
  } else if (event._tag === "Retrying") cache.retrying = { at, message: event.message };
  else if (event._tag === "HookBlocked") cache.hooksBlocked += 1;
}

export const questionTime = (entry: QuestionCacheEntry, timeoutMs: number) =>
  defersAt(DateTime.toEpochMillis(entry.asked.at), timeoutMs, entry.deferred);
