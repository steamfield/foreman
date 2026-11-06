import { Effect } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { guideCommand } from "./commands/guide";
import {
  answerCommand,
  archiveCommand,
  deferCommand,
  eventsCommand,
  followupCommand,
  interruptCommand,
  resultCommand,
  startCommand,
  statusCommand,
  steerCommand,
  waitCommand,
} from "./commands/runs";
import { skillCommand } from "./commands/skill";
import { Output } from "./services/output";

export const cli = (name: string) =>
  Command.make(name).pipe(
    Command.withDescription(
      "Delegate coding tasks to Codex in git worktrees and supervise their questions, progress and hand-offs. Run guide before your first delegation. Exits 0 for help, 2 for usage, 6 when output is refused, 130 when interrupted, 1 on an internal error.",
    ),
    Command.withExamples([
      { command: "foreman guide", description: "Read the agent delegation workflow" },
      { command: "foreman skill install", description: "Install the bundled agent entry point" },
    ]),
    Command.withSharedFlags({
      json: Flag.Boolean("json").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Print the complete result as JSON."),
      ),
    }),
    Command.withHandler(() =>
      Effect.fail(new CliError.ShowHelp({ commandPath: [name], errors: [] })),
    ),
    Command.withSubcommands([
      startCommand,
      statusCommand,
      eventsCommand,
      steerCommand,
      followupCommand,
      interruptCommand,
      answerCommand,
      deferCommand,
      resultCommand,
      archiveCommand,
      waitCommand,
      doctorCommand,
      guideCommand,
      skillCommand,
      daemonCommand,
    ]),
    Command.provideEffectDiscard(({ json }) =>
      Effect.flatMap(Output, (output) => output.setJson(json)),
    ),
  );
