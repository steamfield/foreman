/**
 * `foreman models`: every provider's model catalog, read the way start routing reads it.
 */
import { Effect } from "effect";
import type { ModelsResult } from "../schemas/models";

/**
 * Lists each provider's models with their efforts and defaults. A provider whose catalog
 * can't be read appears with the reason instead of its models.
 */
export const listModels = (): Effect.Effect<ModelsResult> =>
  Effect.die("not implemented: listModels");
