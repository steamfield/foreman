import { Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { durationMs } from "../core/command-input";
import { foremanExecutable, renderResult } from "../core/command-output";
import * as programs from "../core/commands";
import { redactDiagnosticText } from "../logging";
import { EventLimit, EventSequence } from "../schemas/commands";
import { Cursor, DaemonResult, QuestionId, RunName } from "../schemas/daemon";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

const name = Argument.String("name").pipe(
  Argument.withSchema(RunName),
  Argument.withDescription(
    "Run name, global within FOREMAN_HOME: 1 to 64 lowercase letters, digits, dots, underscores or hyphens; start with a letter or digit.",
  ),
);
const optionalText = (flag: string, description: string) =>
  Flag.String(flag).pipe(
    Flag.withDescription(description),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );
const duration = (flag: string, description: string) =>
  Flag.String(flag).pipe(
    Flag.withDescription(description),
    Flag.mapEffect((value) =>
      durationMs(value).pipe(Effect.mapError(() => invalidDuration(flag, value))),
    ),
  );
const invalidDuration = (flag: string, value: string) =>
  new CliError.ValidationError({
    message: `Invalid --${flag} value ${JSON.stringify(redactDiagnosticText(value))}. Use a nonnegative whole number with ms, s, m or h, such as 5m, within the supported range.`,
  });
const optionalDuration = (flag: string, description: string) =>
  duration(flag, description).pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const timeout = Flag.String("timeout").pipe(
  Flag.withDescription("Maximum wait duration, such as 30s or 5m (default: 60m)."),
  Flag.mapEffect((value) =>
    durationMs(value).pipe(
      Effect.as(value),
      Effect.mapError(() => invalidDuration("timeout", value)),
    ),
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);
const waiting = {
  wait: Flag.Boolean("wait").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Wait for attention from this run after accepting the command."),
  ),
  timeout,
};
const message = {
  message: Argument.String("message").pipe(
    Argument.withDescription(
      "Instructions for Codex. Supply exactly one message argument or --file.",
    ),
    Argument.optional,
    Argument.map(Option.getOrUndefined),
  ),
  file: optionalText("file", "Read the message from a file instead of an argument."),
};

export const print = Effect.fnUntraced(function* <E, R>(
  command: string,
  program: Effect.Effect<DaemonResult, E, R>,
  compact = false,
  eventsName?: string,
  verbose = false,
) {
  yield* (yield* Invocation).named(command);
  const result = yield* program;
  const encoded = yield* Schema.encodeEffect(DaemonResult)(result).pipe(Effect.orDie);
  const executable =
    result._tag === "Started" || result._tag === "Events"
      ? (yield* foremanExecutable()).command
      : "foreman";
  yield* (yield* Output).result(
    encoded,
    renderResult(result, compact, executable, eventsName, verbose),
  );
});

export const startCommand = Command.make(
  "start",
  {
    name,
    worktree: optionalText(
      "worktree",
      "Use a prepared linked worktree at its Git root, inside and distinct from the main checkout. Requires dependencies if package.json exists; never removed by foreman. Choose this or --new-worktree.",
    ),
    newWorktree: Flag.Boolean("new-worktree").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Create .claude/worktrees/<name> on foreman/<name> at the caller's HEAD (or --from). Choose this or --worktree.",
      ),
    ),
    from: optionalText(
      "from",
      "Base the new worktree on this Git ref (default: HEAD); requires --new-worktree.",
    ),
    setup: optionalText(
      "setup",
      "Run a shell command before Codex (limit: 10m, or the explicit --budget); requires --new-worktree.",
    ),
    contract: Flag.String("contract").pipe(
      Flag.withDescription("Read the task contract from this file."),
    ),
    write: Flag.Boolean("write").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Allow full host access, commands and network with no approval prompts (default: read-only with network disabled).",
      ),
    ),
    model: optionalText(
      "model",
      "Override the newest visible gpt-*-sol in CODEX_HOME/models_cache.json (default cache: ~/.codex/models_cache.json; fallback model: gpt-6.1-sol).",
    ),
    effort: optionalText("effort", "Set Codex reasoning effort (default: high)."),
    tier: optionalText("tier", "Set the Codex service tier (default: priority)."),
    budgetMs: optionalDuration(
      "budget",
      "Turn budget (default: 60m); also sets the setup limit when supplied.",
    ),
    questionTimeoutMs: optionalDuration(
      "question-timeout",
      "Time before deferring each unanswered question (default: 15m).",
    ),
    skipDepsCheck: Flag.Boolean("skip-deps-check").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Skip the prepared worktree dependency check."),
    ),
    ...waiting,
  },
  (input) => print("start", programs.start(input)),
).pipe(
  Command.withDescription(
    "Start a new run in a managed or prepared linked worktree. Choose exactly one of --new-worktree and --worktree; the worktree must be unreserved. Replacing an inactive run (idle, failed, interrupted or lost) archives its previous records after successful preflight and retains its old worktree. Use followup to continue its saved thread instead. A managed start still needs an unused worktree directory and branch. Active runs (starting, running, waiting, unknown) and queued answers retain ownership. Read-only by default; --write permits full host access with no approval prompts. Managed setup runs before validation and Codex. Refusals roll back only safe owned resources; inspect any retained path before retrying. With --wait, returns attention for this run, not peers. Exits 0 on start or any wait outcome, 2 for usage or unreadable input, 3 for invalid config, 4 for daemon failure, 5 for unavailable Codex, 6 for permissions, 8 for conflicts, 9 for invalid worktrees or missing dependencies, 10 for untrusted repo hooks, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Start a Codex run in a new or prepared worktree."),
  Command.withExamples([
    {
      command:
        'foreman start doctor-help --new-worktree --setup "bun install" --contract /tmp/doctor-help.md --write --wait',
      description: "Start implementation and wait in a background task",
    },
    {
      command: "foreman start audit --worktree .claude/worktrees/audit --contract /tmp/audit.md",
      description: "Audit an installed prepared worktree read-only",
    },
    {
      command:
        "foreman start parser --new-worktree --from main --contract /tmp/parser.md --write --budget 45m --json",
      description: "Start from main with a bounded turn and get start metadata",
    },
  ]),
);

export const statusCommand = Command.make(
  "status",
  {
    name: name.pipe(
      Argument.withDescription(
        "Run to inspect in any state. Omit for all runs in the current repo and linked worktrees.",
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined),
    ),
  },
  ({ name }) => print("status", programs.status(name), name === undefined),
).pipe(
  Command.withDescription(
    "Inspect any current run state, including starting, running, waiting, unknown, idle, failed, interrupted and lost. A named run gets a full digest; no name lists the current repo group and orphan worktrees. Does not resume turns; run commands may start or replace an idle daemon. Both JSON forms return Digests. Exits 0 on success (also an empty group), 2 for usage, 3 for config, 4 for daemon failure, 6 for permissions, 7 for a missing named run, 8 for unreadable or unsupported records, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Show a run digest or one line per run in the current group."),
  Command.withExamples([
    { command: "foreman status", description: "Inspect this repo's runs and orphan worktrees" },
    {
      command: "foreman status doctor-help --json",
      description: "Read one run's state and questions",
    },
  ]),
);

export const eventsCommand = Command.make(
  "events",
  {
    name,
    after: Flag.Int("after").pipe(
      Flag.withDescription("Read events after this sequence number."),
      Flag.withSchema(EventSequence),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of stored events to read (default: 100)."),
      Flag.withSchema(EventLimit),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    verbose: Flag.Boolean("verbose").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Include protocol chatter and token usage in text output; JSON always includes everything.",
      ),
    ),
  },
  (input) => print("events", programs.events(input), false, input.name, input.verbose),
).pipe(
  Command.withDescription(
    "Read stored events in any current run state without resuming it. --after uses a numeric event sequence, not a wait cursor. The page limit counts stored events before text filtering: protocol chatter and token usage are hidden unless --verbose; JSON includes the whole selected page. Exits 0 on success (also an empty page), 2 for usage, 3 for config, 4 for daemon failure, 6 for permissions, 7 for a missing run, 8 for unreadable or unsupported records, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Read run events; text omits protocol chatter unless --verbose."),
  Command.withExamples([
    { command: "foreman events doctor-help", description: "Read the first page of progress" },
    {
      command: "foreman events doctor-help --after 100 --limit 50 --verbose",
      description: "Inspect another page including protocol events",
    },
    {
      command: "foreman events doctor-help --json",
      description: "Get the complete selected event page",
    },
  ]),
);

export const steerCommand = Command.make("steer", { name, ...message, ...waiting }, (input) =>
  print("steer", programs.steer(input)),
).pipe(
  Command.withDescription(
    "Send instructions to a running, steerable turn and supersede unanswered decisions. Refuses starting, waiting, unknown and inactive runs; if a question is pending, answer its id and include the change instead. Codex can refuse a steer: wait, then follow up. --wait waits on this run only after acceptance. Exits 0 on acceptance or any wait outcome, 2 for usage or input, 3 for config, 4 for daemon failure, 5 for Codex failure, 6 for permissions, 7 for a missing run, 8 for state conflicts or refused steering, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Send a change to the active turn."),
  Command.withExamples([
    {
      command: 'foreman steer doctor-help "Mention hook trust in the description" --wait',
      description: "Correct a running turn and wait in the background",
    },
    {
      command: "foreman steer doctor-help --file /tmp/revised-scope.md",
      description: "Send instructions from a file",
    },
  ]),
);

export const followupCommand = Command.make(
  "followup",
  {
    name,
    ...message,
    ...waiting,
    budgetMs: optionalDuration("budget", "Time budget for the follow-up turn (default: 60m)."),
    effort: optionalText("effort", "Set reasoning effort for this and later turns."),
  },
  (input) => print("followup", programs.followup(input)),
).pipe(
  Command.withDescription(
    "Continue an inactive run (idle, failed, interrupted or lost) on its saved thread and existing worktree. Refuses active states (starting, running, waiting, unknown), reserved worktrees, missing threads and queued answers. Supersedes unanswered decisions and retains the original contract scope. --budget applies to this turn; --effort persists for later turns. --wait targets this run only. Read resume warnings about question delivery. Exits 0 on acceptance or any wait outcome, 2 for usage or input, 3 for config, 4 for daemon failure, 5 for Codex failure, 6 for permissions, 7 for a missing run, 8 for conflicts or missing continuation prerequisites, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription(
    "Start a turn on an inactive run; refuses while answers are queued.",
  ),
  Command.withExamples([
    {
      command: 'foreman followup doctor-help "Fix the review findings and rerun lint" --wait',
      description: "Return findings after the previous turn ends",
    },
    {
      command: "foreman followup doctor-help --file /tmp/followup.md --budget 30m --effort high",
      description: "Continue with a written follow-up contract",
    },
  ]),
);

export const interruptCommand = Command.make("interrupt", { name, ...waiting }, (input) =>
  print("interrupt", programs.interrupt(input)),
).pipe(
  Command.withDescription(
    "Request interruption of an active turn and cancel its pending questions. Also cancels start preflight, returning Ok without a cursor or wait even with --wait. Refuses when no thread/active turn is known, including inactive runs; starting or unknown runs can only be interrupted if those ids exist. Read status afterward; interruption is a request, not proof that a writer stopped. --wait targets this run only. Exits 0 on acceptance, preflight cancellation or any wait outcome, 2 for usage, 3 for config, 4 for daemon failure, 5 for Codex failure, 6 for permissions, 7 for a missing run, 8 for a state conflict, 130 when the CLI is interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Interrupt the active turn or cancel start preflight."),
  Command.withExamples([
    {
      command: "foreman interrupt doctor-help --wait",
      description: "Stop a turn and wait for its resulting state in the background",
    },
    {
      command: "foreman interrupt parser --json",
      description: "Request cancellation and inspect the acceptance result",
    },
  ]),
);

export const answerCommand = Command.make(
  "answer",
  {
    name,
    question: Argument.String("question-id").pipe(
      Argument.withSchema(QuestionId),
      Argument.withDescription(
        "Stored question id from status or wait, such as q1; remains addressable after deferral or resolution.",
      ),
    ),
    ...message,
    ...waiting,
    message: Argument.String("text").pipe(
      Argument.withDescription(
        "Decision or correction. Supply exactly one text argument or --file.",
      ),
      Argument.optional,
      Argument.map(Option.getOrUndefined),
    ),
  },
  (input) => print("answer", programs.answer(input)),
).pipe(
  Command.withDescription(
    "Answer a pending question through its held tool call, or send a late answer to a deferred, cancelled or superseded id. Answering an answered id sends a correction with the original question context. A late answer steers a running turn; if refused, waits for inactivity and starts a follow-up. An inactive run (idle, failed, interrupted, lost) needs a saved thread and existing worktree for that follow-up. During a budget hand-off, or behind queued answers, delivery queues in acceptance order; --wait tracks the delivered answer's turn. Starting/unknown turns wait for inactivity for late delivery. If another question is pending, answer that id first and include both decisions. An outdated busy daemon only accepts still-pending questions. Exits 0 on acceptance or any wait outcome, 2 for usage or input, 3 for config, 4 for daemon failure, 5 for Codex failure, 6 for permissions, 7 for a missing run or question, 8 for conflicts, unavailable continuation or incompatible daemon, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription(
    "Answer a question or correct an earlier answer with text or a file.",
  ),
  Command.withExamples([
    {
      command: 'foreman answer doctor-help q1 "Keep the existing public API" --wait',
      description: "Answer a pending or deferred question and wait in the background",
    },
    {
      command: 'foreman answer doctor-help q1 "Correction: rename only the internal helper"',
      description: "Correct the same question after an earlier answer",
    },
    {
      command: "foreman answer doctor-help q2 --file /tmp/owner-decision.md",
      description: "Deliver a longer decision from the owner",
    },
  ]),
);

export const deferCommand = Command.make(
  "defer",
  {
    name,
    question: Argument.String("question-id").pipe(
      Argument.withSchema(QuestionId),
      Argument.withDescription("Pending question id from status or wait, such as q1."),
    ),
    note: Argument.String("note").pipe(
      Argument.withDescription("Optional reason to include with the deferral; default: no note."),
      Argument.optional,
      Argument.map(Option.getOrUndefined),
    ),
    ...waiting,
  },
  (input) => print("defer", programs.defer(input)),
).pipe(
  Command.withDescription(
    "Release a pending question without deciding it, so Codex can continue independent work and report the decision under Open. Accepts only a pending question with its held call (normally a waiting run); refuses deferred, answered, cancelled or superseded ids and an outdated busy daemon. An inactive run has no held call to defer. The question stays unanswered in digests; use answer on the same id later. --wait targets this run only. Exits 0 on acceptance or any wait outcome, 2 for usage, 3 for config, 4 for daemon failure, 5 for Codex failure, 6 for permissions, 7 for a missing run or question, 8 for conflicts or an incompatible daemon, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Release a pending question and leave the decision unanswered."),
  Command.withExamples([
    {
      command: 'foreman defer doctor-help q1 "Waiting for the owner" --wait',
      description: "Let independent work continue while a person decides",
    },
    {
      command: "foreman defer parser q2",
      description: "Defer without an extra note; answer q2 later",
    },
  ]),
);

export const resultCommand = Command.make("result", { name }, ({ name }) =>
  print("result", programs.result(name)),
).pipe(
  Command.withDescription(
    "Read the digest and latest available hand-off in any current run state, without resuming it. The hand-off names its turn; it can be older than the latest turn, or absent. A done turn still needs your diff review and repo gate. Exits 0 on success even without a hand-off, 2 for usage, 3 for config, 4 for daemon failure, 6 for permissions, 7 for a missing run, 8 for unreadable or unsupported records, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Read the digest and latest available hand-off."),
  Command.withExamples([
    {
      command: "foreman result doctor-help",
      description: "Read the hand-off before reviewing the diff",
    },
    {
      command: "foreman result parser --json",
      description: "Inspect which turn supplied the latest hand-off",
    },
  ]),
);

export const archiveCommand = Command.make(
  "archive",
  {
    name,
    keepWorktree: Flag.Boolean("keep-worktree").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Retain the managed worktree and branch when archiving the run."),
    ),
  },
  ({ name, keepWorktree }) => print("archive", programs.archive(name, keepWorktree)),
).pipe(
  Command.withDescription(
    "Archive an inactive run (idle, failed, interrupted or lost), preserve its records and free the name. Refuses active states (starting, running, waiting, unknown) or queued answers. Managed cleanup requires the expected branch, a clean worktree without untracked files and no new commits or a tip merged into its source ref. --keep-worktree retains the managed worktree and branch; prepared worktrees and branches are always retained. Stop waits you started after archiving. Exits 0 on success, 2 for usage, 3 for config, 4 for daemon failure, 6 for permissions, 7 for a missing run, 8 for conflicts including unsafe cleanup, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Archive an inactive run and print its archive path."),
  Command.withExamples([
    {
      command: "foreman archive doctor-help",
      description: "Clean up after merging and checking the worktree is clean",
    },
    {
      command: "foreman archive parser --keep-worktree",
      description: "Free the run name while keeping unfinished work",
    },
  ]),
);

export const waitCommand = Command.make(
  "wait",
  {
    names: name.pipe(
      Argument.withDescription(
        "One or more run names to watch in any state; use --all instead for the current repo group.",
      ),
      Argument.variadic(),
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Wait on all runs in the current repository group."),
    ),
    after: Flag.String("after").pipe(
      Flag.withDescription("Continue from an opaque cursor printed by a previous command."),
      Flag.withSchema(Cursor),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    timeout,
  },
  (input) => print("wait", programs.wait(input)),
).pipe(
  Command.withDescription(
    "Wait for questions or turn outcomes from named runs in any state, or use --all for the current repo group. --all selects the group; otherwise supply run names. Run in a background task. Active runs may produce attention; inactive runs may have unseen completions. All outcomes exit 0: events needs attention, timeout means continue next:, none means --all has no active runs or unseen attention. --after is an opaque wait cursor, distinct from numeric event sequences; it tracks run identity even when names are reused. Default timeout is 60m. Stop waits you started when a run is archived or replaced. Exits 2 for usage or a bad cursor, 3 for config, 4 for daemon failure, 6 for permissions, 7 for missing named runs, 8 for unreadable or unsupported records, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Wait for attention; default timeout is 60 minutes."),
  Command.withExamples([
    {
      command: "foreman wait doctor-help --timeout 9m",
      description: "Wait for one run's attention in a background task",
    },
    {
      command: "foreman wait doctor-help parser --json",
      description: "Supervise two independent runs",
    },
    {
      command: "foreman wait --all",
      description: "Watch this repository and its linked worktrees",
    },
  ]),
);
