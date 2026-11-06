import { DateTime } from "effect";
import {
  activeStates,
  type Digest,
  type QuestionLine,
  type RunEvent,
  type RunRecord,
} from "../../schemas/daemon";
import { pendingQuestions } from "./store";
import type { WorktreeFields } from "./worktree";

const transientKinds = new Set([
  "serverOverloaded",
  "rateLimitExceeded",
  "policyCapacityUnavailable",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "httpConnectionFailed",
]);

function failureHint(info: unknown): "transient" | "usage-limit" | null {
  let kinds: string[] = [];
  if (typeof info === "string") kinds = [info];
  else if (info !== null && typeof info === "object") kinds = Object.keys(info);
  if (kinds.includes("usageLimitExceeded")) return "usage-limit";
  return kinds.some((kind) => transientKinds.has(kind)) ? "transient" : null;
}

export function buildDigest(
  run: RunRecord,
  events: readonly RunEvent[],
  questions: readonly QuestionLine[],
  runDir: string,
  now: number,
  worktree: WorktreeFields | null,
): Digest {
  const commands = events.map((entry) => entry.event).filter((event) => event._tag === "Command");
  const last = commands.at(-1);
  const endedAt =
    events.findLast(({ event }) => event._tag === "StateChanged")?.at ?? run.updatedAt;
  const elapsedUntil = activeStates.has(run.state) ? now : DateTime.toEpochMillis(endedAt);
  const handoffActive =
    run.restoreSandbox && run.turnKind === "handoff" && activeStates.has(run.state);
  const expectedSandbox = run.sandbox === "read-only" ? "readOnly" : "dangerFullAccess";
  const resumeWarnings = events.flatMap(({ event }) =>
    event._tag === "Resumed" && event.sandbox !== expectedSandbox
      ? [`resumed with sandbox ${event.sandbox}, run expects ${expectedSandbox}`]
      : [],
  );
  const warnings = run.warnings.filter(
    (warning) => warning !== "Thread resumed: questions may not reach Claude in this turn.",
  );
  return {
    name: run.name,
    state: run.state,
    elapsedMs: Math.max(0, Math.trunc(elapsedUntil - DateTime.toEpochMillis(run.createdAt))),
    model: run.model,
    effort: run.effort,
    tier: run.tier,
    sandbox: handoffActive ? "read-only" : run.sandbox,
    runDir,
    worktree: run.worktree,
    ...(run.managedWorktree ? { managedWorktree: run.managedWorktree } : {}),
    turn: run.turns,
    turnKind: run.turnKind,
    questions: pendingQuestions(questions).map((question) => ({
      id: question.id,
      kind: question.kind,
      question: question.question,
      pendingMs: Math.max(0, Math.trunc(now - DateTime.toEpochMillis(question.at))),
    })),
    commands: {
      total: commands.length,
      failed: commands.filter(
        (command) =>
          command.status === "failed" || (command.exitCode !== null && command.exitCode !== 0),
      ).length,
      blockedByHooks: events.filter((entry) => entry.event._tag === "HookBlocked").length,
      last: last === undefined ? null : { command: last.command, exitCode: last.exitCode },
    },
    filesWritten: worktree?.filesWritten ?? null,
    outsideMayChange: worktree?.outsideMayChange ?? null,
    newInGitStatus: worktree?.newInGitStatus ?? null,
    tokens: run.tokens,
    failure:
      run.failure === null
        ? null
        : {
            message: run.failure.message,
            hint: failureHint(run.failure.codexErrorInfo),
          },
    warnings: [...new Set([...warnings, ...resumeWarnings])],
  };
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1000) return `${Number((count / 1000).toFixed(1))}K`;
  return String(count);
}

function files(
  label: string,
  value: readonly string[] | null,
  absent = "(not computed)",
  gitStatus = false,
): string[] {
  if (value === null) return [`${label}:  ${absent}`];
  if (value.length === 0) return [`${label}:  (none)`];
  return [
    `${label}:`,
    ...value.slice(0, 50).map((entry) => {
      const text = gitStatus ? `${entry.slice(0, 2).trim().padEnd(2)} ${entry.slice(3)}` : entry;
      return `  ${text}`;
    }),
    ...(value.length > 50 ? [`  … ${value.length - 50} more`] : []),
  ];
}

function commandPreview(command: string): string {
  const first = command.split(/\r?\n/, 1)[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

export function renderStatus(digest: Digest): string {
  return [
    digest.name,
    digest.state,
    `turn ${digest.turn}${digest.turnKind === null ? "" : ` (${digest.turnKind})`}`,
    duration(digest.elapsedMs),
    ...digest.questions.map(({ id }) => `${id} pending`),
    ...(digest.warnings.some((warning) => warning.startsWith("worktree removed: "))
      ? ["worktree removed"]
      : []),
  ].join("  ");
}

export function renderDigest(digest: Digest): string {
  let mode = digest.sandbox === "danger-full-access" ? "write" : "read-only";
  if (
    digest.turnKind === "handoff" &&
    activeStates.has(digest.state) &&
    digest.sandbox === "read-only"
  )
    mode = "read-only (hand-off turn)";
  const scopeAbsent =
    digest.filesWritten === null && digest.newInGitStatus === null
      ? "(not computed)"
      : "(no May change entry)";
  const lines = [
    `run:       ${digest.name}  ${digest.state}  ${duration(digest.elapsedMs)}  (${digest.model}, ${digest.effort}, ${digest.tier}, ${mode})`,
    `dir:       ${digest.runDir}`,
    `worktree:  ${digest.worktree}`,
    ...(digest.managedWorktree
      ? [
          `branch:    ${digest.managedWorktree.branch} (forman-created, base ${digest.managedWorktree.baseCommit})`,
        ]
      : []),
    `turn:      ${digest.turn}${digest.turnKind === null ? "" : ` (${digest.turnKind})`}`,
  ];
  if (digest.questions.length === 0) lines.push("question:  (none)");
  for (const question of digest.questions)
    lines.push(
      `question:  ${question.id} (${question.kind}) pending ${duration(question.pendingMs)}: ${question.question}`,
    );
  lines.push(
    `commands:  ${digest.commands.total} (${digest.commands.failed} failed, ${digest.commands.blockedByHooks} blocked by repo hooks)`,
  );
  lines.push(
    digest.commands.last === null
      ? "  last:    (none)"
      : `  last:    ${commandPreview(digest.commands.last.command)}  exit=${digest.commands.last.exitCode ?? "(none)"}`,
  );
  lines.push(
    ...files("files written", digest.filesWritten),
    ...files("outside May change", digest.outsideMayChange, scopeAbsent),
    ...files("new in git status since start", digest.newInGitStatus, "(not computed)", true),
  );
  if (digest.tokens === null) lines.push("tokens:    (none)");
  else {
    const { input, cachedInput, output } = digest.tokens;
    const cached = input === 0 ? 0 : Math.round((100 * cachedInput) / input);
    lines.push(`tokens:    ${tokenCount(input)} in (${cached}% cached), ${tokenCount(output)} out`);
  }
  if (digest.failure !== null) {
    lines.push(`failure:   ${digest.failure.message}`);
    if (digest.failure.hint === "transient")
      lines.push("transient: send a short followup like 'continue'");
    if (digest.failure.hint === "usage-limit")
      lines.push("usage-limit: the plan's usage limit was reached");
  }
  for (const warning of digest.warnings) lines.push(`warning:   ${warning}`);
  return lines.join("\n");
}
