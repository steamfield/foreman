/**
 * `foreman models [--json]`: the models a start can name, by provider.
 */
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { listModels } from "../core/models";
import { ModelsResult } from "../schemas/models";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

/** The compact text table: one line per model, one per unavailable provider. */
function modelsText(result: ModelsResult): string {
  return result.providers
    .flatMap((provider) =>
      provider.unavailable === null
        ? provider.models.map(
            (entry) =>
              `${provider.provider}  ${entry.model}${entry.default ? " (default)" : ""}  efforts: ${entry.efforts.join(", ") || "fixed"}${entry.defaultEffort === null ? "" : ` (default ${entry.defaultEffort})`}`,
          )
        : [`${provider.provider}: unavailable (${provider.unavailable})`],
    )
    .join("\n");
}

export const modelsCommand = Command.make(
  "models",
  {},
  Effect.fn(function* () {
    yield* Effect.flatMap(Invocation, (invocation) => invocation.named("models"));
    const result = yield* listModels();
    const encoded = yield* Schema.encodeEffect(ModelsResult)(result).pipe(Effect.orDie);
    yield* (yield* Output).result(encoded, modelsText(result));
  }),
).pipe(
  Command.withDescription(
    "List the models foreman can start runs on, by provider (codex, agy): each model's efforts, its default effort, and the default model. A provider that is unavailable is listed with the reason. Pass any listed model to start --model. Exits 0 with the list, 2 for usage, 6 when output is refused, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("List the models each provider offers."),
  Command.withExamples([
    { command: "foreman models", description: "See which models start --model accepts" },
    { command: "foreman models --json", description: "Get the catalogs as one JSON result" },
  ]),
);
