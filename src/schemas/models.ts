import { Schema } from "effect";
import { ProviderId } from "./provider";

// Model catalogs as `foreman models` reports them, the candidates a ModelUnresolved error
// suggests, and the catalog files they are read from. docs/rfcs/0002-providers.md "Model
// routing and its errors" is the design.

/** A model an agent can pass to --model, with the efforts it accepts. */
export const ModelCandidate = Schema.Struct({
  provider: ProviderId,
  model: Schema.String,
  efforts: Schema.Array(Schema.String),
});
export type ModelCandidate = typeof ModelCandidate.Type;

/** One catalog entry in `foreman models`. */
export const ModelEntry = Schema.Struct({
  model: Schema.String,
  efforts: Schema.Array(Schema.String),
  // null when the model has a fixed effort.
  defaultEffort: Schema.NullOr(Schema.String),
  // True for the model a start without --model uses.
  default: Schema.Boolean,
});
export type ModelEntry = typeof ModelEntry.Type;

/** One provider's catalog; an unavailable provider lists no models and says why. */
export const ProviderModels = Schema.Struct({
  provider: ProviderId,
  unavailable: Schema.NullOr(Schema.String),
  models: Schema.Array(ModelEntry),
});
export type ProviderModels = typeof ProviderModels.Type;

/** The `foreman models --json` result. */
export const ModelsResult = Schema.Struct({
  providers: Schema.Array(ProviderModels),
});
export type ModelsResult = typeof ModelsResult.Type;

/** The reasoning fields of one entry in Codex's `models_cache.json`; other fields are ignored. */
export const CodexCacheEfforts = Schema.Struct({
  slug: Schema.String,
  default_reasoning_level: Schema.optionalKey(Schema.NullOr(Schema.String)),
  supported_reasoning_levels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ effort: Schema.String })),
  ),
});

/** Codex's `models_cache.json`, entries left undecoded so one bad entry spoils only itself. */
export const CodexCacheFile = Schema.fromJsonString(
  Schema.Struct({ models: Schema.Array(Schema.Unknown) }),
);

/** agy's catalog cache at `FOREMAN_HOME/providers/agy/models.json`, as the agy adapter writes it. */
export const AgyCacheFile = Schema.fromJsonString(
  Schema.Struct({
    fetchedAt: Schema.String,
    agyVersion: Schema.String,
    models: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        family: Schema.String,
        effort: Schema.NullOr(Schema.String),
        name: Schema.String,
      }),
    ),
  }),
);
