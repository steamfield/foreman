/**
 * The run journal's view of a provider event: which `RunEventBody`s it appends to
 * events.jsonl. Pure; the supervisor appends the result.
 */
import type { ItemSummary, ProviderEvent } from "../providers/contract";
import type { RunEventBody, TurnKind } from "../schemas/daemon";

function completedItem(item: ItemSummary): RunEventBody[] {
  if (item.kind === "command")
    return [
      {
        _tag: "Command",
        command: item.command,
        status: item.status,
        exitCode: item.exitCode,
        outputTail: item.outputTail,
      },
    ];
  if (item.kind === "fileChange") return [{ _tag: "FileChange", paths: item.paths }];
  return [];
}

/**
 * Maps one provider event to the events it journals. `turn` is the run's persisted turn
 * number and `kind` the active turn's kind. Events that only change live state, decode
 * diagnostics and unrecognized messages journal nothing here.
 */
export function toRunEvents(event: ProviderEvent, turn: number, kind: TurnKind): RunEventBody[] {
  switch (event._tag) {
    case "TurnStarted":
      return [{ _tag: "TurnStarted", turn, kind }];
    case "TurnCompleted":
      return [{ _tag: "TurnCompleted", turn, status: event.status, failure: event.failure }];
    case "ItemCompleted":
      return completedItem(event.item);
    case "AgentMessage":
      return [{ _tag: "AgentMessage", text: event.text, phase: event.phase }];
    case "HookBlocked":
      return [{ _tag: "HookBlocked", event: event.event, feedback: event.feedback }];
    case "TokenUsage":
      return [{ _tag: "TokenUsage", totals: event.totals }];
    case "Retrying":
      return [{ _tag: "Retrying", message: event.message }];
    case "McpStartupFailed":
      return [{ _tag: "McpStartupFailed", server: event.server, error: event.error }];
    case "Permission":
      return [
        { _tag: "Permission", kind: event.kind, title: event.title, decision: event.decision },
      ];
    default:
      return [];
  }
}
