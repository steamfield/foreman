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

const name = Argument.String("name").pipe(Argument.withSchema(RunName));
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
  message: Argument.String("message").pipe(Argument.optional, Argument.map(Option.getOrUndefined)),
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
    worktree: optionalText("worktree", "Use an existing prepared worktree."),
    newWorktree: Flag.Boolean("new-worktree").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Create a managed worktree for this run."),
    ),
    from: optionalText("from", "Base the new worktree on this Git ref (default: HEAD)."),
    setup: optionalText(
      "setup",
      "Run a shell command before Codex (limit: 10m, or the explicit --budget).",
    ),
    contract: Flag.String("contract").pipe(
      Flag.withDescription("Read the task contract from this file."),
    ),
    write: Flag.Boolean("write").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Allow Codex to write files and run commands with full access."),
    ),
    model: optionalText("model", "Override the newest visible gpt-*-sol model from Codex's cache."),
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
).pipe(Command.withDescription("Start a Codex run in a new or prepared worktree."));

export const statusCommand = Command.make(
  "status",
  { name: name.pipe(Argument.optional, Argument.map(Option.getOrUndefined)) },
  ({ name }) => print("status", programs.status(name), name === undefined),
).pipe(Command.withDescription("Show a run digest or one line per run in the current group."));

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
).pipe(Command.withDescription("Read run events; text omits protocol chatter unless --verbose."));

export const steerCommand = Command.make("steer", { name, ...message, ...waiting }, (input) =>
  print("steer", programs.steer(input)),
).pipe(Command.withDescription("Send a change to the active turn."));

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
  Command.withDescription("Start a turn on an inactive run; refuses while answers are queued."),
);

export const interruptCommand = Command.make("interrupt", { name, ...waiting }, (input) =>
  print("interrupt", programs.interrupt(input)),
).pipe(Command.withDescription("Interrupt the active turn."));

export const answerCommand = Command.make(
  "answer",
  {
    name,
    question: Argument.String("question-id").pipe(Argument.withSchema(QuestionId)),
    ...message,
    ...waiting,
    message: Argument.String("text").pipe(Argument.optional, Argument.map(Option.getOrUndefined)),
  },
  (input) => print("answer", programs.answer(input)),
).pipe(
  Command.withDescription("Answer a question or correct an earlier answer with text or a file."),
);

export const deferCommand = Command.make(
  "defer",
  {
    name,
    question: Argument.String("question-id").pipe(Argument.withSchema(QuestionId)),
    note: Argument.String("note").pipe(Argument.optional, Argument.map(Option.getOrUndefined)),
    ...waiting,
  },
  (input) => print("defer", programs.defer(input)),
).pipe(Command.withDescription("Release a pending question and leave the decision unanswered."));

export const resultCommand = Command.make("result", { name }, ({ name }) =>
  print("result", programs.result(name)),
).pipe(Command.withDescription("Read the digest and latest available hand-off."));

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
).pipe(Command.withDescription("Archive an inactive run and print its archive path."));

export const waitCommand = Command.make(
  "wait",
  {
    names: name.pipe(Argument.variadic()),
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
).pipe(Command.withDescription("Wait for attention; default timeout is 60 minutes."));
