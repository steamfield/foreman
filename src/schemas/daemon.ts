import { Schema } from "effect";
import { InterruptedBy, makeDetailSchema, Overview } from "./monitor";
import { ProviderId } from "./provider";

// Shapes shared by the foreman CLI, the daemon and the run store: run state on disk, the
// normalized event log, the digest, and the socket protocol. docs/rfcs/0001-foreman.md is the
// design these implement.

export const RunName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)).pipe(
  Schema.brand("RunName"),
);
export type RunName = typeof RunName.Type;

export const DaemonLockOwner = Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) });

export const QuestionId = Schema.String.check(Schema.isPattern(/^q[1-9][0-9]*$/)).pipe(
  Schema.brand("QuestionId"),
);
export type QuestionId = typeof QuestionId.Type;

// Opaque to the CLI and to Claude; only the daemon builds and reads it.
export const Cursor = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("Cursor"));
export type Cursor = typeof Cursor.Type;

export const RunState = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "unknown",
  "idle",
  "failed",
  "interrupted",
  "lost",
]);
export type RunState = typeof RunState.Type;
export const activeStates: ReadonlySet<RunState> = new Set([
  "starting",
  "running",
  "waiting",
  "unknown",
]);

export const Sandbox = Schema.Literals(["read-only", "danger-full-access"]);
export type Sandbox = typeof Sandbox.Type;

export const TurnKind = Schema.Literals(["start", "followup", "handoff"]);
export type TurnKind = typeof TurnKind.Type;
export { InterruptedBy };

// Unversioned storage is version 1. Question/event writers use version 2. A run.json for a
// non-Codex provider is version 3, so binaries that predate providers refuse it.
// Socket peers negotiate builds; incompatible busy daemons refuse new question commands.
export const StorageHeader = Schema.Struct({
  formatVersion: Schema.optionalKey(Schema.Literals([1, 2, 3])),
});

export const QuestionResolution = Schema.Literals([
  "answered",
  "auto-answered",
  "cancelled",
  "late",
  "correction",
  "superseded",
]);
export const AnswerDelivery = Schema.Literals(["response", "steer", "followup", "queued"]);
export type AnswerDelivery = typeof AnswerDelivery.Type;

export const QuestionKind = Schema.Literals(["question", "blocked"]);
export type QuestionKind = typeof QuestionKind.Type;

export const TokenTotals = Schema.Struct({
  input: Schema.Number,
  cachedInput: Schema.Number,
  output: Schema.Number,
  reasoningOutput: Schema.Number,
});
export type TokenTotals = typeof TokenTotals.Type;

export const RunFailure = Schema.Struct({
  message: Schema.String,
  // Codex's codexErrorInfo, kept as received.
  codexErrorInfo: Schema.NullOr(Schema.Unknown),
});

export const ManagedWorktree = Schema.Struct({
  branch: Schema.String,
  baseCommit: Schema.String,
  fromRef: Schema.String,
});
export const OrphanWorktree = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  holdsWork: Schema.Boolean,
});
export const SkippedRun = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  action: Schema.String,
});

// runs/<name>/run.json, written atomically.
export const RunRecord = Schema.Struct({
  name: RunName,
  threadId: Schema.NullOr(Schema.String),
  // Absent means Codex: every run written before providers existed.
  provider: Schema.optionalKey(ProviderId),
  // The main checkout of the worktree; status and wait --all cover one group.
  group: Schema.String,
  worktree: Schema.String,
  baseCommit: Schema.String,
  managedWorktree: Schema.optionalKey(ManagedWorktree),
  model: Schema.String,
  effort: Schema.String,
  tier: Schema.String,
  sandbox: Sandbox,
  questionTimeoutMs: Schema.Int,
  state: RunState,
  // Turns started on this run so far; the current or last turn is this number.
  turns: Schema.Int,
  turnKind: Schema.NullOr(TurnKind),
  activeTurnId: Schema.NullOr(Schema.String),
  turnBudgetMs: Schema.NullOr(Schema.Int),
  turnStartedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  // True when the last turn ran under a read-only hand-off policy that the next follow-up must
  // replace with the run's own sandbox.
  restoreSandbox: Schema.Boolean,
  tokens: Schema.NullOr(TokenTotals),
  failure: Schema.NullOr(RunFailure),
  warnings: Schema.Array(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  // Set by a Review request; cleared when a new turn starts.
  reviewedAt: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
  pendingStateEvent: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        from: RunState,
        to: RunState,
      }),
    ),
  ),
});
export type RunRecord = typeof RunRecord.Type;

/** The provider that drives a run; a record without the field is a Codex run. */
export const providerOf = (record: { readonly provider?: ProviderId }): ProviderId =>
  record.provider ?? "codex";

// runs/<name>/events.jsonl: one RunEvent per line.
export const RunEventBody = Schema.TaggedUnion({
  Resumed: { sandbox: Schema.String, model: Schema.String },
  Permission: {
    kind: Schema.String,
    title: Schema.String,
    decision: Schema.Literals(["approved", "rejected"]),
  },
  TurnStarted: { turn: Schema.Int, kind: TurnKind },
  TurnCompleted: {
    turn: Schema.Int,
    status: Schema.String,
    failure: Schema.NullOr(RunFailure),
  },
  Command: {
    command: Schema.String,
    status: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    // The last 2 KB of aggregated output.
    outputTail: Schema.String,
  },
  FileChange: { paths: Schema.Array(Schema.String) },
  AgentMessage: { text: Schema.String, phase: Schema.NullOr(Schema.String) },
  HookBlocked: { event: Schema.String, feedback: Schema.String },
  QuestionAsked: { id: QuestionId, kind: QuestionKind, question: Schema.String },
  QuestionResolved: {
    id: QuestionId,
    // Binds a queued answer's cursor to the turn that actually received it.
    continuation: Schema.optionalKey(Schema.Struct({ id: Schema.String, turn: Schema.Int })),
    resolution: Schema.Literals([
      "answered",
      "auto-answered",
      "cancelled",
      "deferred",
      "late",
      "correction",
      "superseded",
    ]),
    // Present when a person answered or deferred from foreman monitor.
    source: Schema.optionalKey(Schema.Literal("monitor")),
  },
  Steered: { message: Schema.String },
  Interrupted: { by: InterruptedBy },
  TokenUsage: { totals: TokenTotals },
  McpStartupFailed: { server: Schema.String, error: Schema.NullOr(Schema.String) },
  Retrying: { message: Schema.String },
  StateChanged: { from: RunState, to: RunState },
  Other: { method: Schema.String },
});
export type RunEventBody = typeof RunEventBody.Type;

export const RunEvent = Schema.Struct({
  transitionId: Schema.optionalKey(Schema.String),
  seq: Schema.Int,
  at: Schema.DateTimeUtcFromString,
  event: RunEventBody,
});
export type RunEvent = typeof RunEvent.Type;

// runs/<name>/questions.jsonl: one line when a question is asked, one when it is resolved.
export const QuestionLine = Schema.TaggedUnion({
  Asked: {
    id: QuestionId,
    turn: Schema.Int,
    kind: QuestionKind,
    question: Schema.String,
    at: Schema.DateTimeUtcFromString,
  },
  Resolved: {
    id: QuestionId,
    resolution: QuestionResolution,
    delivery: Schema.optionalKey(AnswerDelivery),
    // The answer sent to Codex; null when cancelled or superseded.
    text: Schema.NullOr(Schema.String),
    at: Schema.DateTimeUtcFromString,
  },
  Deferred: {
    id: QuestionId,
    by: Schema.Literals(["timeout", "orchestrator"]),
    note: Schema.optionalKey(Schema.String),
    at: Schema.DateTimeUtcFromString,
  },
});
export type QuestionLine = typeof QuestionLine.Type;

export const PendingQuestion = Schema.Struct({
  id: QuestionId,
  kind: QuestionKind,
  question: Schema.String,
  pendingMs: Schema.Int,
});

export const Digest = Schema.Struct({
  name: RunName,
  provider: Schema.optionalKey(ProviderId),
  state: RunState,
  elapsedMs: Schema.Int,
  model: Schema.String,
  effort: Schema.String,
  tier: Schema.String,
  sandbox: Sandbox,
  runDir: Schema.String,
  worktree: Schema.String,
  managedWorktree: Schema.optionalKey(ManagedWorktree),
  turn: Schema.Int,
  turnKind: Schema.NullOr(TurnKind),
  questions: Schema.Array(PendingQuestion),
  unansweredQuestions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: QuestionId,
        kind: QuestionKind,
        question: Schema.String,
      }),
    ),
  ),
  commands: Schema.Struct({
    total: Schema.Int,
    failed: Schema.Int,
    blockedByHooks: Schema.Int,
    last: Schema.NullOr(
      Schema.Struct({ command: Schema.String, exitCode: Schema.NullOr(Schema.Number) }),
    ),
  }),
  // The three worktree fields are null until first computed (at turn end, status or result).
  filesWritten: Schema.NullOr(Schema.Array(Schema.String)),
  outsideMayChange: Schema.NullOr(Schema.Array(Schema.String)),
  newInGitStatus: Schema.NullOr(Schema.Array(Schema.String)),
  tokens: Schema.NullOr(TokenTotals),
  failure: Schema.NullOr(
    Schema.Struct({
      message: Schema.String,
      hint: Schema.NullOr(Schema.Literals(["transient", "usage-limit"])),
    }),
  ),
  // Set while the run is interrupted: the cause of its latest interruption.
  interruptedBy: Schema.optionalKey(InterruptedBy),
  warnings: Schema.Array(Schema.String),
});
export type Digest = typeof Digest.Type;

export const Handoff = Schema.Struct({ turn: Schema.Int, text: Schema.String });

// The socket protocol: one JSON object per line. Every path is absolute and real by the time
// it reaches the daemon; the CLI resolves them.

export const DaemonRequestBody = Schema.TaggedUnion({
  Ping: {},
  Shutdown: {},
  Start: {
    name: RunName,
    worktree: Schema.String,
    newWorktree: Schema.optionalKey(Schema.Boolean),
    from: Schema.optionalKey(Schema.String),
    setup: Schema.optionalKey(Schema.String),
    contract: Schema.String,
    write: Schema.Boolean,
    // Omitted for Codex, so a 0.3 daemon still accepts every Codex start.
    provider: Schema.optionalKey(ProviderId),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    tier: Schema.optionalKey(Schema.String),
    budgetMs: Schema.optionalKey(Schema.Int),
    questionTimeoutMs: Schema.optionalKey(Schema.Int),
    skipDepsCheck: Schema.Boolean,
  },
  // Without a name, every run in the group of `cwd`.
  Status: { name: Schema.optionalKey(RunName), cwd: Schema.String },
  Overview: {
    after: Schema.optionalKey(Schema.Int),
    timeoutMs: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
    ),
  },
  Detail: {
    name: RunName,
    after: Schema.optionalKey(Schema.Int),
    timeoutMs: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
    ),
  },
  Events: {
    name: RunName,
    after: Schema.optionalKey(Schema.Int),
    limit: Schema.optionalKey(Schema.Int),
    waitMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 }))),
  },
  Steer: { name: RunName, message: Schema.String },
  Followup: {
    name: RunName,
    message: Schema.String,
    budgetMs: Schema.optionalKey(Schema.Int),
    effort: Schema.optionalKey(Schema.String),
  },
  Interrupt: { name: RunName, source: Schema.optionalKey(Schema.Literal("monitor")) },
  // A person marked the run's result reviewed in foreman monitor.
  Review: { name: RunName },
  Answer: {
    name: RunName,
    question: QuestionId,
    text: Schema.String,
    // Set by the monitor: refuse with RunConflict instead of sending a late answer or correction.
    expectOpen: Schema.optionalKey(Schema.Literal(true)),
    source: Schema.optionalKey(Schema.Literal("monitor")),
  },
  Defer: {
    name: RunName,
    question: QuestionId,
    note: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.Literal("monitor")),
  },
  Result: { name: RunName },
  Archive: { name: RunName, keepWorktree: Schema.optionalKey(Schema.Boolean) },
  Wait: {
    names: Schema.Array(RunName),
    all: Schema.Boolean,
    cwd: Schema.String,
    after: Schema.optionalKey(Cursor),
    timeoutMs: Schema.Int,
  },
});
export type DaemonRequestBody = typeof DaemonRequestBody.Type;

export const DaemonRequest = Schema.Struct({
  id: Schema.Int,
  body: DaemonRequestBody,
  passive: Schema.optionalKey(Schema.Literal(true)),
});
export type DaemonRequest = typeof DaemonRequest.Type;

export const WaitOutcome = Schema.Struct({
  name: RunName,
  kind: Schema.Literals(["question", "done", "failed", "interrupted", "lost"]),
  // The one-line text after the run name, for example "q2 (blocked): <question>" or "turn 1".
  summary: Schema.String,
  digest: Digest,
  handoff: Schema.NullOr(Handoff),
});

export const DaemonResult = Schema.TaggedUnion({
  Detail: makeDetailSchema(Digest, Handoff).fields,
  Overview: {
    version: Overview.fields.version,
    daemon: Overview.fields.daemon,
    runs: Overview.fields.runs,
  },
  Pong: {
    version: Schema.String,
    pid: Schema.Int,
    build: Schema.optionalKey(Schema.String),
    codexBin: Schema.optionalKey(Schema.String),
    agyBin: Schema.optionalKey(Schema.String),
    codexHome: Schema.optionalKey(Schema.String),
  },
  Started: {
    name: RunName,
    runDir: Schema.String,
    worktree: Schema.optionalKey(Schema.String),
    branch: Schema.optionalKey(Schema.String),
  },
  Archived: { name: RunName, archivePath: Schema.String },
  Digests: {
    digests: Schema.Array(Digest),
    orphans: Schema.optionalKey(Schema.Array(OrphanWorktree)),
    skipped: Schema.optionalKey(Schema.Array(SkippedRun)),
  },
  Events: {
    events: Schema.Array(RunEvent),
    gap: Schema.Boolean,
    next: Schema.Int,
    state: Schema.optionalKey(RunState),
  },
  Ok: {},
  Accepted: {
    cursor: Cursor,
    all: Schema.optionalKey(Schema.Boolean),
    // The CLI supplies the executable-aware continuation.
    next: Schema.optionalKey(Schema.String),
    delivery: Schema.optionalKey(AnswerDelivery),
  },
  Result: {
    digest: Digest,
    handoff: Schema.NullOr(Handoff),
    // True when the latest turn ended without a hand-off and `handoff` is from an earlier turn.
    latestTurnWithoutHandoff: Schema.Boolean,
  },
  Waited: {
    // start --wait keeps its start metadata in the same JSON value as the outcome.
    started: Schema.optionalKey(
      Schema.Struct({
        name: RunName,
        runDir: Schema.String,
        worktree: Schema.optionalKey(Schema.String),
        branch: Schema.optionalKey(Schema.String),
      }),
    ),
    outcome: Schema.Literals(["events", "timeout", "none"]),
    runs: Schema.Array(WaitOutcome),
    skipped: Schema.optionalKey(Schema.Array(SkippedRun)),
    cursor: Cursor,
    next: Schema.String,
    alternative: Schema.optionalKey(Schema.String),
  },
});
export type DaemonResult = typeof DaemonResult.Type;

// Error tags match src/errors.ts; the CLI rebuilds the error from tag and detail.
export const DaemonErrorBody = Schema.Struct({
  tag: Schema.String,
  detail: Schema.optionalKey(Schema.String),
});

export const DaemonResponse = Schema.Union([
  Schema.Struct({ id: Schema.Int, result: DaemonResult }),
  Schema.Struct({ id: Schema.Int, error: DaemonErrorBody }),
]);
export type DaemonResponse = typeof DaemonResponse.Type;
