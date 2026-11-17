import { DateTime, Effect, FileSystem, Path } from "effect";
import { redactDiagnosticText } from "../../logging";
import type { QuestionId, RunRecord } from "../../schemas/daemon";
import type { RunView } from "../../schemas/monitor";
import {
  activity,
  handoffLine,
  type QuestionCacheEntry,
  questionTime,
  updateQuestion,
} from "../monitor/attention";
import type { SavedOverview } from "../monitor/feed";
import { buildDigest } from "./digest";
import { contractTitle } from "./normalize";
import { stateSince } from "./state-since";
import * as Store from "./store";

export const diskRunView = Effect.fn("runs.diskRunView")(function* (
  dir: string,
  record: RunRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const optionalText = (file: string) =>
    fs
      .readFileString(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));

  const questions = new Map<QuestionId, QuestionCacheEntry>();
  for (const line of yield* Store.readQuestions(dir)) updateQuestion(questions, line);
  const handoff = yield* optionalText(path.join(dir, "last-message.md"));
  const title = contractTitle(yield* optionalText(path.join(dir, "contract.md")));
  const at = DateTime.toEpochMillis(record.updatedAt);
  const { events } = yield* Store.readEvents(dir, 0, Number.MAX_SAFE_INTEGER);
  const commands = events
    .map((entry) => entry.event)
    .filter((event) => event._tag === "Command")
    .filter((event) => event.exitCode !== null);
  const filesWritten = new Set(
    events.flatMap(({ event }) => (event._tag === "FileChange" ? event.paths : [])),
  );
  const digest = buildDigest(record, [], [], dir, at, null);
  const current = activity({
    state: record.state,
    openItem: null,
    commentary: null,
    handoff: handoff === "" ? null : handoffLine(handoff, at),
    failure: digest.failure === null ? null : { text: digest.failure.message, at },
  });
  const view: RunView = {
    name: record.name,
    group: record.group,
    repo: path.basename(record.group),
    worktree: record.worktree,
    branch: record.managedWorktree?.branch ?? null,
    title,
    model: record.model,
    effort: record.effort,
    tier: record.tier,
    sandbox: digest.sandbox,
    state: record.state,
    stateSince: stateSince(record, events),
    turn: record.turns,
    turnKind: record.turnKind,
    turnStartedAt: record.turnStartedAt,
    turnBudgetMs: record.turnBudgetMs,
    tokensTotal: record.tokens === null ? 0 : record.tokens.input + record.tokens.output,
    activity:
      current === null
        ? null
        : {
            kind: current.kind,
            text: redactDiagnosticText(current.text),
            since: record.updatedAt,
          },
    questions: [...questions.values()]
      .filter((entry) => !entry.deferred)
      .map((entry) => {
        const deadline = questionTime(entry, record.questionTimeoutMs);
        return {
          id: entry.asked.id,
          kind: entry.asked.kind,
          text: entry.asked.question,
          askedAt: entry.asked.at,
          defersAt: deadline === null ? null : DateTime.makeUnsafe(deadline),
        };
      }),
    unansweredCount: [...questions.values()].filter((entry) => entry.deferred).length,
    failure: digest.failure,
    retrying: null,
    hooksBlocked: 0,
    outsideMayChange: null,
    quiet: false,
    lastActivityAt: null,
    subagents: [],
    warnings: record.warnings,
    commands: {
      total: commands.length,
      failed: commands.filter((command) => command.exitCode !== 0).length,
    },
    filesWritten: filesWritten.size,
    pace: [],
    reviewedAt: record.reviewedAt ?? null,
    interruptedBy:
      record.state === "interrupted"
        ? (events.map(({ event }) => event).findLast((event) => event._tag === "Interrupted")?.by ??
          null)
        : null,
  };
  return view;
});

/** Read the recorded state without recovery, git refreshes or store mutations. */
export const diskOverview = Effect.fn("runs.diskOverview")(function* (home: string) {
  const path = yield* Path.Path;
  const stored = yield* Store.readAllRuns(home);
  const runs: RunView[] = [];
  for (const record of stored.runs) {
    const loaded = yield* Effect.gen(function* () {
      return yield* diskRunView(path.join(home, "runs", record.name), record);
    }).pipe(Effect.result);
    // Like recovery, a damaged run must not hide the remaining runs.
    if (loaded._tag === "Success") runs.push(loaded.success);
  }
  return { _tag: "Overview", daemon: null, runs } satisfies SavedOverview;
});
