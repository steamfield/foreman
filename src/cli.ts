import { Effect } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { doctorCommand } from "./commands/doctor";
import {
  answerCommand,
  eventsCommand,
  followupCommand,
  interruptCommand,
  resultCommand,
  startCommand,
  statusCommand,
  steerCommand,
  waitCommand,
} from "./commands/runs";
import { Output } from "./services/output";

export const cli = (name: string) =>
  Command.make(name).pipe(
    Command.withSharedFlags({ json: Flag.Boolean("json").pipe(Flag.withDefault(false)) }),
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
      resultCommand,
      waitCommand,
      doctorCommand,
    ]),
    Command.provideEffectDiscard(({ json }) =>
      Effect.flatMap(Output, (output) => output.setJson(json)),
    ),
  );
