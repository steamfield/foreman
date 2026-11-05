import { Schema } from "effect";

// Shapes shared by the forman CLI, the daemon and the run store: run state on disk, the
// normalized event log, the digest, and the socket protocol. docs/rfcs/0001-forman.md is the
// design these implement.

export const RunName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)).pipe(
  Schema.brand("RunName"),
);
export type RunName = typeof RunName.Type;

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

// runs/<name>/run.json, written atomically.
export const RunRecord = Schema.Struct({
  name: RunName,
  threadId: Schema.NullOr(Schema.String),
  // The main checkout of the worktree; status and wait --all cover one group.
  group: Schema.String,
  worktree: Schema.String,
  baseCommit: Schema.String,
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
});
export type RunRecord = typeof RunRecord.Type;

// runs/<name>/events.jsonl: one RunEvent per line.
export const RunEventBody = Schema.TaggedUnion({
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
    resolution: Schema.Literals(["answered", "auto-answered", "cancelled"]),
  },
  Steered: { message: Schema.String },
  Interrupted: { by: Schema.Literals(["orchestrator", "budget", "repo-hooks"]) },
  TokenUsage: { totals: TokenTotals },
  McpStartupFailed: { server: Schema.String, error: Schema.NullOr(Schema.String) },
  Retrying: { message: Schema.String },
  StateChanged: { from: RunState, to: RunState },
  Other: { method: Schema.String },
});
export type RunEventBody = typeof RunEventBody.Type;

export const RunEvent = Schema.Struct({
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
    resolution: Schema.Literals(["answered", "auto-answered", "cancelled"]),
    // The answer sent to Codex; null when cancelled.
    text: Schema.NullOr(Schema.String),
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
  state: RunState,
  elapsedMs: Schema.Int,
  model: Schema.String,
  effort: Schema.String,
  tier: Schema.String,
  sandbox: Sandbox,
  runDir: Schema.String,
  worktree: Schema.String,
  turn: Schema.Int,
  turnKind: Schema.NullOr(TurnKind),
  questions: Schema.Array(PendingQuestion),
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
  warnings: Schema.Array(Schema.String),
});
export type Digest = typeof Digest.Type;

export const Handoff = Schema.Struct({ turn: Schema.Int, text: Schema.String });

// The socket protocol: one JSON object per line. Every path is absolute and real by the time
// it reaches the daemon; the CLI resolves them.

export const DaemonRequestBody = Schema.TaggedUnion({
  Ping: {},
  Start: {
    name: RunName,
    worktree: Schema.String,
    contract: Schema.String,
    write: Schema.Boolean,
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    tier: Schema.optionalKey(Schema.String),
    budgetMs: Schema.optionalKey(Schema.Int),
    questionTimeoutMs: Schema.optionalKey(Schema.Int),
    skipDepsCheck: Schema.Boolean,
  },
  // Without a name, every run in the group of `cwd`.
  Status: { name: Schema.optionalKey(RunName), cwd: Schema.String },
  Events: {
    name: RunName,
    after: Schema.optionalKey(Schema.Int),
    limit: Schema.optionalKey(Schema.Int),
  },
  Steer: { name: RunName, message: Schema.String },
  Followup: {
    name: RunName,
    message: Schema.String,
    budgetMs: Schema.optionalKey(Schema.Int),
    effort: Schema.optionalKey(Schema.String),
  },
  Interrupt: { name: RunName },
  Answer: { name: RunName, question: QuestionId, text: Schema.String },
  Result: { name: RunName },
  Wait: {
    names: Schema.Array(RunName),
    all: Schema.Boolean,
    cwd: Schema.String,
    after: Schema.optionalKey(Cursor),
    timeoutMs: Schema.Int,
  },
});
export type DaemonRequestBody = typeof DaemonRequestBody.Type;

export const DaemonRequest = Schema.Struct({ id: Schema.Int, body: DaemonRequestBody });
export type DaemonRequest = typeof DaemonRequest.Type;

export const WaitOutcome = Schema.Struct({
  name: RunName,
  kind: Schema.Literals(["question", "done", "failed", "interrupted", "lost"]),
  // The one-line text after the run name, for example "q2 (blocked): <question>" or "turn 1".
  summary: Schema.String,
  digest: Digest,
});

export const DaemonResult = Schema.TaggedUnion({
  Pong: { version: Schema.String, pid: Schema.Int },
  Started: { name: RunName, runDir: Schema.String },
  Digests: { digests: Schema.Array(Digest) },
  Events: { events: Schema.Array(RunEvent), gap: Schema.Boolean, next: Schema.Int },
  Ok: {},
  Result: {
    digest: Digest,
    handoff: Schema.NullOr(Handoff),
    // True when the latest turn ended without a hand-off and `handoff` is from an earlier turn.
    latestTurnWithoutHandoff: Schema.Boolean,
  },
  Waited: {
    outcome: Schema.Literals(["events", "timeout", "none"]),
    runs: Schema.Array(WaitOutcome),
    cursor: Cursor,
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
