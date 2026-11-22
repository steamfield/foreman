import { activeStates, type RunEvent } from "../../schemas/daemon";
import type { Detail, RunView } from "../../schemas/monitor";
import { tokenCount } from "../runs/digest";
import { shellCommand } from "./attention";
import type { DetailFeed } from "./detail-feed";
import { age, cleanText, clockTime, oneLine, plural, stamp, unsupervised } from "./format";
import type { DetailLine, State, Tone } from "./model-types";
import { providerTag } from "./row";

/** Formats the run's command, file and token digest. */
export function digestFacts(data: Detail): string[] {
  const digest = data.digest;
  // The worktree fields stay null until a turn ends or status refreshes them.
  const files = [
    digest.filesWritten && `${digest.filesWritten.length} written`,
    digest.outsideMayChange && `${digest.outsideMayChange.length} outside May change`,
    digest.newInGitStatus && `${digest.newInGitStatus.length} new in git status`,
  ].filter((part) => part !== null);
  const tokens = digest.tokens;
  return [
    `commands  ${digest.commands.total} total · ${digest.commands.failed} failed · ${digest.commands.blockedByHooks} hooks blocked`,
    `last command  ${digest.commands.last ? shellCommand(digest.commands.last.command) : "none"}${digest.commands.last?.exitCode === null || !digest.commands.last ? "" : ` · exit ${digest.commands.last.exitCode}`}`,
    `files  ${files.length > 0 ? files.join(" · ") : "counted when the turn ends"}`,
    `tokens  ${tokenCount(tokens?.input ?? 0)} input · ${tokenCount(tokens?.cachedInput ?? 0)} cached (${!tokens?.input ? 0 : Math.round((100 * tokens.cachedInput) / tokens.input)}% hit)`,
    `        ${tokenCount(tokens?.output ?? 0)} output · ${tokenCount(tokens?.reasoningOutput ?? 0)} reasoning`,
    ...(digest.failure ? [`failure  ${digest.failure.message}`] : []),
  ];
}

/** Lists the CLI actions applicable to the inspected run. */
export function detailCommands(state: State, data: Detail): string[] {
  const run = data.run;
  return [
    ...(run.group === state.group
      ? [
          ...data.questions
            .filter((q) => q.status === "pending")
            .map((q) => `foreman answer ${run.name} ${q.id} --file <path>`),
          ...(activeStates.has(run.state) ? [`foreman interrupt ${run.name}`] : []),
        ]
      : ["other repo: its own session supervises it"]),
    `foreman result ${run.name}`,
    `foreman events ${run.name} --follow`,
  ];
}

/** Formats saved or reconnecting detail connection notices. */
export function detailConnection(detail: NonNullable<State["detail"]>) {
  let connection = "live";
  let message: readonly string[] = [];
  if (detail.feed?._tag === "Saved") {
    connection = `saved · ${detail.feed.reason}`;
    message = [
      detail.feed.reason === "outdated"
        ? "Saved state · daemon is outdated"
        : "Saved state · daemon not running",
      "The monitor checks again automatically; start work in another terminal.",
      `foreman status ${detail.name}`,
    ];
  } else if (detail.feed?._tag === "Reconnecting") {
    connection = "reconnecting";
    message = [
      "Reconnecting to daemon",
      oneLine(detail.feed.reason),
      `foreman status ${detail.name}`,
    ];
  }
  return { connection, message };
}

/** Formats the model fact; non-Codex runs lead with their provider and have no tier. */
function modelFact(run: RunView): string {
  const tag = providerTag(run);
  if (tag === "") return `${run.model} · ${run.effort} · ${run.tier}`;
  return `${tag}· ${run.model} · ${run.effort}`;
}

/** Formats the run's recorded worktree and execution metadata. */
export function detailHeader(state: State, data: Detail, connection: string) {
  const { run, record } = data;
  return [
    ["worktree", record.worktree],
    ["branch", record.branch ?? "not recorded"],
    ["base", record.baseCommit.slice(0, 12)],
    ["--from", record.fromRef ?? "not recorded"],
    ["created", stamp(record.createdAt, state.now)],
    ["updated", stamp(record.updatedAt, state.now)],
    ["run dir", record.runDir],
    ["model", modelFact(run)],
    ["turn", `${run.turn} ${run.turnKind ?? ""}`],
    ["connection", connection],
  ].map(([label, value]) => [label ?? "", cleanText(value ?? "")] as const);
}

/** Formats each subagent status and interaction timestamp. */
export function subagentLines(run: RunView, feed: DetailFeed | null, now: number): DetailLine[] {
  return run.subagents.length
    ? run.subagents.flatMap((agent) => [
        {
          text: `${oneLine(agent.path)} · ${agent.state}${agent.model && agent.model !== run.model ? ` · ${oneLine(agent.model)}` : ""}${agent.effort && agent.effort !== run.effort ? ` · ${oneLine(agent.effort)}` : ""}`,
          tone: "fg" as const,
          kind:
            !unsupervised(feed) && agent.state === "working"
              ? ("working" as const)
              : ("subagent-idle" as const),
        },
        {
          text: `started ${clockTime(agent.startedAt)} · ${plural(agent.interactions, "interaction")} · ${age(agent.lastInteractionAt, now)} ago`,
          tone: "muted" as const,
        },
      ])
    : [{ text: "No subagents recorded.", tone: "muted" }];
}

/** Formats a command event with its completion glyph and tone. */
export function commandLine(event: Extract<RunEvent["event"], { _tag: "Command" }>): DetailLine {
  const open =
    event.exitCode === null && !["completed", "failed", "declined"].includes(event.status);
  const failed =
    ["failed", "declined"].includes(event.status) ||
    (event.exitCode !== null && event.exitCode !== 0);
  const command = shellCommand(event.command);
  if (open) return { text: command, tone: "running", symbol: "…" };
  if (failed) return { text: command, tone: "failed", symbol: `×${event.exitCode ?? ""}` };
  return { text: command, tone: "done", symbol: "✓" };
}

/** Frames a pending question or blocked hook in the event feed. */
export function questionFrame(
  event: Extract<RunEvent["event"], { _tag: "QuestionAsked" | "HookBlocked" }>,
  data: Detail,
  timestamp: string,
): DetailLine[] {
  const pending =
    event._tag === "QuestionAsked" &&
    data.questions.some((q) => q.id === event.id && q.status === "pending");
  let tone: Tone = pending ? "signal" : "muted";
  if (event._tag === "HookBlocked") tone = "failed";
  const title = event._tag === "QuestionAsked" ? `■ ${event.kind} ${event.id}` : "■ hooks blocked";
  const text =
    event._tag === "QuestionAsked" ? event.question : `${event.event}: ${event.feedback}`;
  return [
    { text: title, tone, at: timestamp, frame: "top" },
    { text: oneLine(text), tone: "fg", frame: "body" },
    { text: "", tone: "line", frame: "bottom" },
  ];
}
