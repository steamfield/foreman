import { Schema } from "effect";
import * as Codex from "../../schemas/codex";
import type { RunEventBody, TurnKind } from "../../schemas/daemon";

export type DecodedNotification =
  | { method: "turn/started" | "turn/completed"; params: typeof Codex.TurnNotification.Type }
  | { method: "item/started" | "item/completed"; params: typeof Codex.ItemNotification.Type }
  | { method: "hook/started" | "hook/completed"; params: typeof Codex.HookNotification.Type }
  | { method: "thread/tokenUsage/updated"; params: typeof Codex.TokenUsageNotification.Type }
  | { method: "error"; params: typeof Codex.ErrorNotification.Type }
  | { method: "mcpServer/startupStatus/updated"; params: typeof Codex.McpStartupNotification.Type }
  | { method: `${string}/delta`; params: unknown };

function outputTail(output: string | null): string {
  const bytes = new TextEncoder().encode(output ?? "");
  let start = Math.max(0, bytes.length - 2048);
  // Keep the tail valid UTF-8 without inserting a replacement character at the cut.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

function completedItem(item: Codex.ThreadItem): RunEventBody[] {
  if (Schema.is(Codex.CommandExecutionItem)(item))
    return [
      {
        _tag: "Command",
        command: item.command,
        status: item.status,
        exitCode: item.exitCode,
        outputTail: outputTail(item.aggregatedOutput),
      },
    ];
  if (Schema.is(Codex.FileChangeItem)(item))
    return [{ _tag: "FileChange", paths: item.changes.map((change) => change.path) }];
  if (Schema.is(Codex.AgentMessageItem)(item))
    return [{ _tag: "AgentMessage", text: item.text, phase: item.phase }];
  return [];
}

export function normalizeNotification(
  notification: DecodedNotification,
  turn: number,
  kind: TurnKind,
): RunEventBody[] {
  switch (notification.method) {
    case "turn/started":
      return [{ _tag: "TurnStarted", turn, kind }];
    case "turn/completed":
      return [
        {
          _tag: "TurnCompleted",
          turn,
          status: notification.params.turn.status,
          failure: notification.params.turn.error,
        },
      ];
    case "item/completed":
      return completedItem(notification.params.item);
    case "hook/completed": {
      const run = notification.params.run;
      return run.status === "blocked"
        ? [
            {
              _tag: "HookBlocked",
              event: run.eventName,
              feedback: run.entries.map((entry) => entry.text).join("\n"),
            },
          ]
        : [];
    }
    case "thread/tokenUsage/updated": {
      const total = notification.params.tokenUsage.total;
      return [
        {
          _tag: "TokenUsage",
          totals: {
            input: total.inputTokens,
            cachedInput: total.cachedInputTokens,
            output: total.outputTokens,
            reasoningOutput: total.reasoningOutputTokens,
          },
        },
      ];
    }
    case "error":
      return notification.params.willRetry
        ? [{ _tag: "Retrying", message: notification.params.error.message }]
        : [];
    case "mcpServer/startupStatus/updated":
      return notification.params.status === "failed"
        ? [
            {
              _tag: "McpStartupFailed",
              server: notification.params.name,
              error: notification.params.error,
            },
          ]
        : [];
    case "item/started":
    case "hook/started":
      return [];
  }
  return [];
}

export function pickHandoff(items: readonly Codex.ThreadItem[]): string | null {
  const messages = items.filter(Schema.is(Codex.AgentMessageItem));
  return (
    messages.findLast((item) => item.phase === "final_answer")?.text ??
    messages.at(-1)?.text ??
    null
  );
}
