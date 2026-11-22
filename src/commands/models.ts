/**
 * `foreman models [--json]`: the models a start can name, by provider.
 */
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { listModels } from "../core/models";
import { ModelsResult, type ProviderModels } from "../schemas/models";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

const TABLE_HEADER = ["PROVIDER", "MODEL", "EFFORTS", "DEFAULT EFFORT"] as const;
const COLUMN_GAP = "  ";

/** One table row per listed model; the default model is marked after its id. */
function modelRows(provider: ProviderModels): string[][] {
  return provider.models.map((entry) => [
    provider.provider,
    entry.default ? `${entry.model} (default)` : entry.model,
    entry.efforts.join(",") || "fixed",
    entry.defaultEffort ?? "-",
  ]);
}

/** Rows padded into aligned columns. */
function alignedRows(rows: readonly (readonly string[])[]): string[] {
  const widths = TABLE_HEADER.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join(COLUMN_GAP)
      .trimEnd(),
  );
}

/** The compact text table, then one line per unavailable provider with its reason. */
function modelsText(result: ModelsResult): string {
  const rows = result.providers.flatMap(modelRows);
  const table = rows.length === 0 ? [] : alignedRows([TABLE_HEADER, ...rows]);
  const unavailable = result.providers.flatMap((provider) =>
    provider.unavailable === null
      ? []
      : [`${provider.provider}: unavailable (${provider.unavailable})`],
  );
  return [...table, ...unavailable].join("\n");
}

/**
 * The `foreman models` command: prints every provider's catalog as a table or one JSON value.
 * @throws Never; output failures are handled by the invocation boundary.
 */
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
