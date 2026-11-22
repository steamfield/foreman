import { Schema } from "effect";
import { ProviderId } from "./provider";

// Model catalogs as `foreman models` reports them, and the candidates a ModelUnresolved error
// suggests. docs/rfcs/0002-providers.md "Model routing and its errors" is the design.

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

/** One provider's catalog; an unavailable provider lists no models and says why. */
export const ProviderModels = Schema.Struct({
  provider: ProviderId,
  unavailable: Schema.NullOr(Schema.String),
  models: Schema.Array(ModelEntry),
});

/** The `foreman models --json` result. */
export const ModelsResult = Schema.Struct({
  providers: Schema.Array(ProviderModels),
});
export type ModelsResult = typeof ModelsResult.Type;
