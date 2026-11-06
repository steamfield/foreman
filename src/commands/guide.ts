import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { guide } from "../core/guide";
import { GuideResult } from "../schemas/guide";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

export const guideCommand = Command.make(
  "guide",
  {
    topic: Argument.String("topic").pipe(
      Argument.withDescription(
        "Workflow topic: core (default), contract, contract tests, supervise, review or recover. Separate contract and tests with a space.",
      ),
      Argument.variadic(),
    ),
  },
  ({ topic }) =>
    Effect.gen(function* () {
      yield* (yield* Invocation).named("guide");
      const result = yield* guide(topic);
      yield* (yield* Output).result(Schema.encodeSync(GuideResult)(result), result.text);
    }),
).pipe(
  Command.withDescription(
    "Read the agent delegation workflow or print a fillable contract. Works without a run, Codex or a daemon, in any directory; never changes run state. No topic prints the core guide. Exits 0 on success, 2 for an unknown topic or usage error, 6 when output is refused, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Print the agent workflow or a contract template."),
  Command.withExamples([
    { command: "foreman guide", description: "Read this installed version's delegation workflow" },
    {
      command: "foreman guide contract tests",
      description: "Print the contract for an independent test author",
    },
    {
      command: "foreman guide supervise --json",
      description: "Read question and wait procedures as one JSON result",
    },
  ]),
);
