import { Clock, DateTime, Deferred, Effect, Path } from "effect";
import { activity, questionTime, quiet } from "../core/monitor/attention";
import { buildDigest } from "../core/runs/digest";
import { redactDiagnosticText } from "../logging";
import type { DaemonRequestBody } from "../schemas/daemon";
import type { Overview, RunView } from "../schemas/monitor";
import { advancePace } from "./pace";
import type { Registry, Run } from "./registry";

export const OVERVIEW_COALESCE_MS = 250;

export function projectRun(run: Run, repo: string, now: number): RunView {
  const record = run.record;
  // Reuse the digest's failure classification without reading its journals or refreshing git.
  const digest = buildDigest(record, [], [], run.dir, now, run.worktree);
  const current = activity({
    state: record.state,
    openItem: run.openItem,
    commentary: run.lastCommentary,
    handoff: run.lastHandoff,
    failure: digest.failure === null ? null : { text: digest.failure.message, at: run.stateSince },
  });
  return {
    name: record.name,
    group: record.group,
    repo,
    worktree: record.worktree,
    branch: record.managedWorktree?.branch ?? null,
    title: run.title,
    model: record.model,
    effort: record.effort,
    tier: record.tier,
    sandbox: digest.sandbox,
    state: record.state,
    stateSince: DateTime.makeUnsafe(run.stateSince),
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
            since: DateTime.makeUnsafe(current.at),
          },
    questions: [...run.questions.values()]
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
    unansweredCount: [...run.questions.values()].filter((entry) => entry.deferred).length,
    failure: digest.failure,
    retrying:
      run.retrying === null ? null : { ...run.retrying, at: DateTime.makeUnsafe(run.retrying.at) },
    hooksBlocked: run.hooksBlocked,
    outsideMayChange: run.worktree?.outsideMayChange?.length ?? null,
    quiet: quiet(record.state, run.openItem, run.lastActivityAt, now),
    lastActivityAt: run.lastActivityAt === null ? null : DateTime.makeUnsafe(run.lastActivityAt),
    subagents: [...run.subagents.values()].map((agent) => ({
      ...agent,
      startedAt: DateTime.makeUnsafe(agent.startedAt),
      lastInteractionAt: DateTime.makeUnsafe(agent.lastInteractionAt),
    })),
    warnings: record.warnings,
    commands: run.commands === null ? null : { ...run.commands },
    filesWritten: run.filesWritten?.size ?? null,
    pace: advancePace(run.pace, now).buckets,
    reviewedAt: null,
  };
}

export const waitForVersion = Effect.fnUntraced(function* (
  registry: Registry,
  after?: number,
  timeoutMs = 15000,
  run?: Run,
) {
  const change = run === undefined ? yield* registry.change : Deferred.await(run.changed);
  if (after !== undefined && after === (run?.version ?? registry.version)) {
    const changed = yield* change.pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.succeed(false),
      }),
    );
    if (changed) yield* Effect.sleep(OVERVIEW_COALESCE_MS);
  }
});

/** Read the current live run projections after an optional version wait. */
export const overview = Effect.fn("supervisor.overview")(function* (
  registry: Registry,
  daemon: Overview["daemon"],
  body: Extract<DaemonRequestBody, { _tag: "Overview" }>,
): Effect.fn.Return<Overview, never, Path.Path> {
  yield* waitForVersion(registry, body.after, body.timeoutMs);
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  return {
    _tag: "Overview",
    version: registry.version,
    daemon,
    runs: [...registry.runs.values()]
      .filter(registry.isCurrent)
      .map((run) => projectRun(run, path.basename(run.record.group), now)),
  };
});
