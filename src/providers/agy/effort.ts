/**
 * Checks the effort a follow-up asks for against agy's catalog, so a level the model doesn't
 * offer is refused up front rather than breaking the next resume.
 */
import { Clock, Effect } from "effect";
import { agyUnavailable, routingError } from "../routing-errors";
import { readAgyCatalogIfInstalled } from "./catalog";
import { agySettings, matchAgyModel } from "./models";

/** What reading the catalog needs. */
export interface AgyEffortOptions {
  readonly agyBin: string;
  /** The directories `agyBin` is looked up in when it has no path. */
  readonly searchPath: string;
  readonly home: string;
  /** The filtered provider environment `agy` runs with. */
  readonly environment: Effect.Effect<Record<string, string>>;
}

/**
 * Fails when `model` (the run's recorded family or id) doesn't offer `effort`.
 * @throws {ModelUnresolved} When the effort isn't one the model offers, naming the valid ones;
 * or when agy isn't installed and so can't vouch for it.
 * @throws {AgyUnavailable} When agy is installed but its catalog can't be read.
 */
export const checkAgyEffort = Effect.fn("agy.checkEffort")(function* (
  options: AgyEffortOptions,
  model: string,
  effort: string,
) {
  const read = yield* readAgyCatalogIfInstalled({
    agyBin: options.agyBin,
    searchPath: options.searchPath,
    env: yield* options.environment,
    home: options.home,
    now: yield* Clock.currentTimeMillis,
    refresh: false,
  });
  if (read._tag === "NotInstalled")
    return yield* routingError(agyUnavailable(model, read.reason, false));
  const match = matchAgyModel(model, read.catalog);
  // A model agy no longer lists can't be checked; the turn itself will report it.
  if (match === null) return;
  const settings = agySettings({ effort }, model, match, read.catalog);
  if (settings._tag !== "AgySettings") return yield* routingError(settings);
});
