/**
 * Codex thread items reduced to provider events: the kind of a started item, the event a
 * completed item produces, the hand-off text of a turn and the command output tail.
 *
 * Pure functions over decoded Codex items; nothing here decodes wire messages.
 */
import { Schema } from "effect";
import * as Codex from "../../schemas/codex";
import type { ProviderEvent, TurnId } from "../contract";

/** The started-item kinds the supervisor tells apart, hook enforcement among them. */
export type StartedItemKind = Extract<ProviderEvent, { _tag: "ItemStarted" }>["kind"];

const OUTPUT_TAIL_BYTES = 2048;

/** Wire item types that are tool calls of one kind or another. */
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(["dynamicToolCall", "mcpToolCall"]);

/** Classifies a Codex item type, known or not, into the kind the supervisor records. */
export function startedItemKind(type: string): StartedItemKind {
  if (type === "commandExecution") return "command";
  if (type === "fileChange") return "fileChange";
  if (type === "agentMessage") return "agentMessage";
  if (TOOL_ITEM_TYPES.has(type)) return "tool";
  return "other";
}

/** Returns the last 2 KB of command output, cut so the tail stays valid UTF-8. */
export function outputTail(output: string | null): string {
  const bytes = new TextEncoder().encode(output ?? "");
  let start = Math.max(0, bytes.length - OUTPUT_TAIL_BYTES);
  // Skip continuation bytes so the cut never lands inside a multi-byte character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/**
 * Picks a turn's hand-off: the last `final_answer` agent message, else the last agent
 * message of any phase, else null when the turn produced none.
 */
export function pickHandoff(items: readonly Codex.ThreadItem[]): string | null {
  const messages = items.filter(Schema.is(Codex.AgentMessageItem));
  return (
    messages.findLast((item) => item.phase === "final_answer")?.text ??
    messages.at(-1)?.text ??
    null
  );
}

function messagePhase(phase: string | null): "commentary" | "final_answer" | null {
  return phase === "commentary" || phase === "final_answer" ? phase : null;
}

function subAgentEvent(turn: TurnId, item: typeof Codex.SubAgentActivityItem.Type): ProviderEvent {
  return {
    _tag: "SubAgent",
    turn,
    activity: {
      kind: item.kind,
      threadId: item.agentThreadId,
      path: item.agentPath,
      model: item.model ?? null,
      effort: item.reasoningEffort ?? null,
      startedAtMs: item.startedAtMs ?? null,
    },
  };
}

/** Maps a completed Codex item to the one event the supervisor records for it. */
export function completedItemEvent(turn: TurnId, item: Codex.ThreadItem): ProviderEvent {
  if (Schema.is(Codex.CommandExecutionItem)(item))
    return {
      _tag: "ItemCompleted",
      turn,
      item: {
        kind: "command",
        id: item.id,
        command: item.command,
        status: item.status,
        exitCode: item.exitCode,
        outputTail: outputTail(item.aggregatedOutput),
      },
    };
  if (Schema.is(Codex.FileChangeItem)(item))
    return {
      _tag: "ItemCompleted",
      turn,
      item: { kind: "fileChange", id: item.id, paths: item.changes.map((change) => change.path) },
    };
  if (Schema.is(Codex.AgentMessageItem)(item))
    return { _tag: "AgentMessage", turn, text: item.text, phase: messagePhase(item.phase) };
  if (Schema.is(Codex.SubAgentActivityItem)(item)) return subAgentEvent(turn, item);
  return { _tag: "ItemCompleted", turn, item: { kind: "other", id: item.id, type: item.type } };
}
