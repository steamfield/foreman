import { DateTime, Effect, FileSystem, Path } from "effect";
import { AppConfig } from "../config";
import type { DaemonResult, Handoff, OrphanWorktree, RunEventBody } from "../schemas/daemon";
import { Host } from "../services/host";
import { renderDigest, renderStatus } from "./runs/digest";

// Keep multiline event payloads on one line without losing their boundaries.
const oneLine = (text: string) => text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");

const shellQuote = (text: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

export const formanExecutable = Effect.fn("output.formanExecutable")(function* () {
  const host = yield* Host;
  const config = yield* AppConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executable =
    config.launcher === null
      ? host.executable.map((part) => path.resolve(part))
      : [config.launcher];
  const running = yield* fs.realPath(executable[0] ?? "").pipe(Effect.result);
  let onPath = false;
  for (const directory of config.inheritedEnvironment.PATH?.split(path.sep === "\\" ? ";" : ":") ??
    []) {
    const candidate = path.resolve(directory, "forman");
    const info = yield* fs.stat(candidate).pipe(Effect.result);
    if (
      info._tag === "Failure" ||
      info.success.type !== "File" ||
      (info.success.mode & 0o111) === 0
    )
      continue;
    const resolved = yield* fs.realPath(candidate).pipe(Effect.result);
    onPath =
      executable.length === 1 &&
      running._tag === "Success" &&
      resolved._tag === "Success" &&
      resolved.success === running.success;
    break;
  }
  const command = onPath ? "forman" : executable.map(shellQuote).join(" ");
  return { onPath, command: `FORMAN_HOME=${shellQuote(config.home)} ${command}` };
});

function eventSummary(event: RunEventBody): string {
  switch (event._tag) {
    case "Resumed":
      return `sandbox=${event.sandbox} model=${event.model}`;
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

function renderHandoff(handoff: typeof Handoff.Type | null): string {
  return handoff === null
    ? "No hand-off available."
    : `Hand-off (turn ${handoff.turn}):\n${handoff.text}`;
}

export const renderOrphan = (orphan: typeof OrphanWorktree.Type) =>
  `orphan: ${orphan.path}  ${orphan.branch}  ${orphan.holdsWork ? "holds work" : "clean"}`;

const worktreeLines = (started: { worktree?: string; branch?: string }) =>
  started.worktree ? [`worktree: ${started.worktree}`, `branch: ${started.branch}`] : [];

export function renderResult(
  result: DaemonResult,
  compact = false,
  executable = "forman",
  eventsName?: string,
): string {
  switch (result._tag) {
    case "Pong":
      return `running ${result.version} (pid ${result.pid})`;
    case "Started":
      return [
        result.name,
        result.runDir,
        ...worktreeLines(result),
        `next: ${executable} wait ${result.name}`,
      ].join("\n");
    case "Archived":
      return result.archivePath;
    case "Digests":
      return [
        ...(result.digests.length === 0
          ? ["no runs"]
          : result.digests.map(compact ? renderStatus : renderDigest)),
        ...(result.orphans ?? []).map(renderOrphan),
      ].join(compact ? "\n" : "\n\n");
    case "Events":
      return [
        ...(result.gap ? ["gap: true"] : []),
        ...result.events.map(
          ({ seq, at, event }) =>
            `${seq} ${DateTime.formatIso(at)} ${event._tag} ${oneLine(eventSummary(event))}`,
        ),
        `next: ${executable} events ${eventsName} --after ${result.next}`,
      ].join("\n");
    case "Ok":
      return "ok";
    case "Accepted":
      return `ok\nnext: ${result.next}`;
    case "Result":
      return [
        renderDigest(result.digest),
        renderHandoff(result.handoff),
        ...(result.latestTurnWithoutHandoff
          ? [`Latest turn (${result.digest.turn}) ended without a hand-off.`]
          : []),
      ].join("\n\n");
    case "Waited":
      return [
        ...(result.started
          ? [result.started.name, result.started.runDir, ...worktreeLines(result.started)]
          : []),
        ...(result.outcome === "events"
          ? result.runs.map(
              ({ kind, name, summary }) => `${kind.padEnd(12)}${name} ${oneLine(summary)}`,
            )
          : [result.outcome]),
        ...result.runs.flatMap(({ kind, digest, handoff }) => [
          "",
          renderDigest(digest),
          ...(["done", "failed", "interrupted"].includes(kind) ? ["", renderHandoff(handoff)] : []),
        ]),
        ...(result.runs.length === 0 ? [] : [""]),
        `cursor: ${result.cursor}`,
        `next: ${result.next}`,
      ].join("\n");
  }
}
