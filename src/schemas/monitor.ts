import { Schema } from "effect";

const Timestamp = Schema.DateTimeUtcFromString;

export const SubAgentView = Schema.Struct({
  threadId: Schema.String,
  path: Schema.String,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  state: Schema.Literals(["working", "idle"]),
  startedAt: Timestamp,
  lastInteractionAt: Timestamp,
  interactions: Schema.Int,
}).annotate({ title: "SubAgentView", description: "A supervised run's child agent" });
export type SubAgentView = typeof SubAgentView.Type;

export const InterruptedBy = Schema.Literals(["orchestrator", "budget", "repo-hooks", "monitor"]);
export type InterruptedBy = typeof InterruptedBy.Type;

/** Minutes covered by `RunView.pace`. */
export const PACE_MINUTES = 12;

export const RunView = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)).pipe(
    Schema.brand("RunName"),
  ),
  group: Schema.String,
  repo: Schema.String,
  worktree: Schema.String,
  branch: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  model: Schema.String,
  effort: Schema.String,
  tier: Schema.String,
  sandbox: Schema.Literals(["read-only", "danger-full-access"]),
  state: Schema.Literals([
    "starting",
    "running",
    "waiting",
    "unknown",
    "idle",
    "failed",
    "interrupted",
    "lost",
  ]),
  stateSince: Timestamp,
  turn: Schema.Int,
  turnKind: Schema.NullOr(Schema.Literals(["start", "followup", "handoff"])),
  turnStartedAt: Schema.NullOr(Timestamp),
  turnBudgetMs: Schema.NullOr(Schema.Int),
  tokensTotal: Schema.Number,
  activity: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["command", "message", "outcome", "failure"]),
      text: Schema.String,
      since: Timestamp,
    }),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^q[1-9][0-9]*$/)).pipe(Schema.brand("QuestionId")),
      kind: Schema.Literals(["question", "blocked"]),
      text: Schema.String,
      askedAt: Timestamp,
      defersAt: Schema.NullOr(Timestamp),
    }),
  ),
  unansweredCount: Schema.Int,
  failure: Schema.NullOr(
    Schema.Struct({ message: Schema.String, hint: Schema.NullOr(Schema.String) }),
  ),
  retrying: Schema.NullOr(Schema.Struct({ at: Timestamp, message: Schema.String })),
  hooksBlocked: Schema.Int,
  outsideMayChange: Schema.NullOr(Schema.Number),
  quiet: Schema.Boolean,
  lastActivityAt: Schema.NullOr(Timestamp),
  subagents: Schema.Array(SubAgentView),
  warnings: Schema.Array(Schema.String),
  // Commands finished in this run so far, and how many exited non-zero; null when unknown.
  commands: Schema.NullOr(Schema.Struct({ total: Schema.Int, failed: Schema.Int })),
  // Distinct paths the run has written; null when unknown.
  filesWritten: Schema.NullOr(Schema.Int),
  // Journal events per minute over the last PACE_MINUTES minutes, oldest first; empty when not supervised.
  pace: Schema.Array(Schema.Int),
  // When a person marked the latest result reviewed in foreman monitor; null when not reviewed.
  reviewedAt: Schema.NullOr(Timestamp),
  // Who caused the latest interruption while the run is interrupted; null otherwise or when unknown.
  interruptedBy: Schema.NullOr(InterruptedBy),
}).annotate({
  title: "RunView",
  description: "Cached live state and attention for a supervised run",
});
export type RunView = typeof RunView.Type;

export const Overview = Schema.TaggedStruct("Overview", {
  version: Schema.Int,
  daemon: Schema.Struct({ version: Schema.String, build: Schema.String, startedAt: Timestamp }),
  runs: Schema.Array(RunView),
}).annotate({ title: "Overview", description: "All current runs across repository groups" });
export type Overview = typeof Overview.Type;

export const HistoryEntry = Schema.Struct({
  name: RunView.fields.name,
  repo: Schema.String,
  title: Schema.NullOr(Schema.String),
  state: RunView.fields.state,
  archived: Schema.Boolean,
  model: Schema.String,
  effort: Schema.String,
  createdAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
  turns: Schema.Int,
  tokensTotal: Schema.Number,
  commands: RunView.fields.commands,
  filesWritten: RunView.fields.filesWritten,
  // Where the run's files live: the run directory or its archive directory.
  dir: Schema.String,
}).annotate({
  title: "HistoryEntry",
  description:
    "A finished or archived run's outcome, read from disk for the monitor's history view",
});
export type HistoryEntry = typeof HistoryEntry.Type;

export const DetailQuestion = Schema.Struct({
  id: RunView.fields.questions.value.fields.id,
  kind: Schema.Literals(["question", "blocked"]),
  text: Schema.String,
  askedAt: Timestamp,
  status: Schema.Literals(["pending", "deferred", "resolved", "cancelled"]),
  resolvedAt: Schema.NullOr(Timestamp),
});

// The protocol supplies its existing schemas, avoiding a runtime cycle back to daemon.ts.
export const makeDetailSchema = (
  digest: typeof import("./daemon").Digest,
  handoff: typeof import("./daemon").Handoff,
) =>
  Schema.TaggedStruct("Detail", {
    version: Schema.Int,
    run: RunView,
    digest,
    record: Schema.Struct({
      runDir: Schema.String,
      worktree: Schema.String,
      branch: Schema.NullOr(Schema.String),
      baseCommit: Schema.String,
      fromRef: Schema.NullOr(Schema.String),
      createdAt: Timestamp,
      updatedAt: Timestamp,
    }),
    contract: Schema.String,
    contractTruncated: Schema.Boolean,
    contractByteLimit: Schema.Int,
    questions: Schema.Array(DetailQuestion),
    handoff: Schema.NullOr(handoff),
  }).annotate({
    title: "Detail",
    description:
      "Read-only run detail without worktree refreshes; version tracks this run's visible changes, not other runs",
  });
export type Detail = ReturnType<typeof makeDetailSchema>["Type"];
