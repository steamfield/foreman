import { DateTime } from "effect";
import type { DaemonResult, RunEventBody } from "../schemas/daemon";
import { renderDigest } from "./runs/digest";

// Keep multiline event payloads on one line without losing their boundaries.
const oneLine = (text: string) => text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");

function eventSummary(event: RunEventBody): string {
  switch (event._tag) {
    case "TurnStarted":
      return `turn ${event.turn} (${event.kind})`;
    case "TurnCompleted":
      return `turn ${event.turn} ${event.status}${event.failure ? `: ${event.failure.message}` : ""}`;
    case "Command":
      return `${event.command}  ${event.status} exit=${event.exitCode ?? "(none)"}`;
    case "FileChange":
      return event.paths.join(", ");
    case "AgentMessage":
      return event.text;
    case "HookBlocked":
      return `${event.event}: ${event.feedback}`;
    case "QuestionAsked":
      return `${event.id} (${event.kind}): ${event.question}`;
    case "QuestionResolved":
      return `${event.id} ${event.resolution}`;
    case "Steered":
    case "Retrying":
      return event.message;
    case "Interrupted":
      return event.by;
    case "TokenUsage":
      return `${event.totals.input} in, ${event.totals.cachedInput} cached, ${event.totals.output} out, ${event.totals.reasoningOutput} reasoning`;
    case "McpStartupFailed":
      return `${event.server}${event.error === null ? "" : `: ${event.error}`}`;
    case "StateChanged":
      return `${event.from} -> ${event.to}`;
    case "Other":
      return event.method;
  }
}

export function renderResult(result: DaemonResult): string {
  switch (result._tag) {
    case "Pong":
      return `running ${result.version} (pid ${result.pid})`;
    case "Started":
      return `${result.name}\n${result.runDir}`;
    case "Archived":
      return result.archivePath;
    case "Digests":
      return result.digests.length === 0
        ? "no runs"
        : result.digests.map(renderDigest).join("\n\n");
    case "Events":
      return [
        ...(result.gap ? ["gap: true"] : []),
        ...result.events.map(
          ({ seq, at, event }) =>
            `${seq} ${DateTime.formatIso(at)} ${event._tag} ${oneLine(eventSummary(event))}`,
        ),
        `next: ${result.next}`,
      ].join("\n");
    case "Ok":
      return "ok";
    case "Result":
      return [
        renderDigest(result.digest),
        result.handoff === null
          ? "No hand-off available."
          : `Hand-off (turn ${result.handoff.turn}):\n${result.handoff.text}`,
        ...(result.latestTurnWithoutHandoff
          ? [`Latest turn (${result.digest.turn}) ended without a hand-off.`]
          : []),
      ].join("\n\n");
    case "Waited":
      return [
        ...(result.outcome === "events"
          ? result.runs.map(
              ({ kind, name, summary }) => `${kind.padEnd(12)}${name} ${oneLine(summary)}`,
            )
          : [result.outcome]),
        ...result.runs.flatMap(({ digest }) => ["", renderDigest(digest)]),
        ...(result.runs.length === 0 ? [] : [""]),
        `cursor: ${result.cursor}`,
      ].join("\n");
  }
}
