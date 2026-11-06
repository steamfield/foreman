import { Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { durationMs } from "../core/command-input";
import { formanExecutable, renderResult } from "../core/command-output";
import * as programs from "../core/commands";
import { Defect } from "../errors";
import { EventLimit, EventSequence } from "../schemas/commands";
import { Cursor, DaemonResult, QuestionId, RunName } from "../schemas/daemon";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

const name = Argument.String("name").pipe(Argument.withSchema(RunName));
const optionalText = (flag: string) =>
  Flag.String(flag).pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const duration = (flag: string) =>
  Flag.String(flag).pipe(
    Flag.mapEffect((value) =>
      durationMs(value).pipe(
        Effect.mapError(() => new CliError.ValidationError({ message: "Invalid duration." })),
      ),
    ),
  );
const optionalDuration = (flag: string) =>
  duration(flag).pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const timeout = Flag.String("timeout").pipe(
  Flag.mapEffect((value) =>
    durationMs(value).pipe(
      Effect.as(value),
      Effect.mapError(() => new CliError.ValidationError({ message: "Invalid duration." })),
    ),
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);
const waiting = {
  wait: Flag.Boolean("wait").pipe(Flag.withDefault(false)),
  timeout,
};
const message = {
  message: Argument.String("message").pipe(Argument.optional, Argument.map(Option.getOrUndefined)),
  file: optionalText("file"),
};

const print = Effect.fnUntraced(function* <E, R>(
  command: string,
  program: Effect.Effect<DaemonResult, E, R>,
  compact = false,
) {
  yield* (yield* Invocation).named(command);
  const result = yield* program;
  const encoded = yield* Schema.encodeEffect(DaemonResult)(result).pipe(
    Effect.mapError(() => new Defect()),
  );
  const executable = result._tag === "Started" ? (yield* formanExecutable()).command : "forman";
  yield* (yield* Output).result(encoded, renderResult(result, compact, executable));
});

export const startCommand = Command.make(
  "start",
  {
    name,
    worktree: optionalText("worktree"),
    newWorktree: Flag.Boolean("new-worktree").pipe(Flag.withDefault(false)),
    from: optionalText("from"),
    setup: optionalText("setup"),
    contract: Flag.String("contract"),
    write: Flag.Boolean("write").pipe(Flag.withDefault(false)),
    model: optionalText("model"),
    effort: optionalText("effort"),
    tier: optionalText("tier"),
    budgetMs: optionalDuration("budget").pipe(
      Flag.withDescription(
        "Turn budget; also bounds setup when supplied (setup defaults to 10 minutes).",
      ),
    ),
    questionTimeoutMs: optionalDuration("question-timeout"),
    skipDepsCheck: Flag.Boolean("skip-deps-check").pipe(Flag.withDefault(false)),
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
      Flag.withSchema(EventSequence),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withSchema(EventLimit),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
  },
  (input) => print("events", programs.events(input)),
).pipe(Command.withDescription("Read normalized run events after a sequence number."));

export const steerCommand = Command.make("steer", { name, ...message, ...waiting }, (input) =>
  print("steer", programs.steer(input)),
).pipe(Command.withDescription("Send a change to the active turn."));

export const followupCommand = Command.make(
  "followup",
  {
    name,
    ...message,
    ...waiting,
    budgetMs: optionalDuration("budget"),
    effort: optionalText("effort"),
  },
  (input) => print("followup", programs.followup(input)),
).pipe(Command.withDescription("Start a follow-up turn with a message or file."));

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
).pipe(Command.withDescription("Answer a pending question with text or a file."));

export const resultCommand = Command.make("result", { name }, ({ name }) =>
  print("result", programs.result(name)),
).pipe(Command.withDescription("Read the digest and latest available hand-off."));

export const archiveCommand = Command.make(
  "archive",
  { name, keepWorktree: Flag.Boolean("keep-worktree").pipe(Flag.withDefault(false)) },
  ({ name, keepWorktree }) => print("archive", programs.archive(name, keepWorktree)),
).pipe(Command.withDescription("Archive an inactive run and print its archive path."));

export const waitCommand = Command.make(
  "wait",
  {
    names: name.pipe(Argument.variadic()),
    all: Flag.Boolean("all").pipe(Flag.withDefault(false)),
    after: Flag.String("after").pipe(
      Flag.withSchema(Cursor),
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    timeout,
  },
  (input) => print("wait", programs.wait(input)),
).pipe(Command.withDescription("Wait for attention; default timeout is 60 minutes."));
