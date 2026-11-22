/**
 * The agy model catalog: `agy models` parsed into model families and effort suffixes, cached
 * under foreman's home for a day and refreshed when agy's version changes.
 */
import { Effect, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { AgyUnavailable } from "../../errors";

/** One model `agy models` lists. */
export interface AgyModel {
  /** The id agy accepts, such as `gemini-4-neon-low`. */
  readonly id: string;
  /** The id without its effort suffix (`gemini-4-neon`); the id itself when there is none. */
  readonly family: string;
  /** low, medium, high or xhigh, from the id's suffix; null when it has none. */
  readonly effort: string | null;
  /** agy's display name. */
  readonly name: string;
}

export interface AgyCatalog {
  /** ISO time of the `agy models` run. */
  readonly fetchedAt: string;
  readonly agyVersion: string;
  readonly models: readonly AgyModel[];
}

/** Parses `agy models` stdout: `<id>\t<name>` lines after an optional "Fetching..." line. */
export function parseAgyModels(_stdout: string): AgyModel[] {
  throw new Error("not implemented");
}

export interface ReadAgyCatalogOptions {
  readonly agyBin: string;
  /** The provider environment `agy` runs with. */
  readonly env: Record<string, string>;
  /** foreman's home; the cache is `<home>/providers/agy/models.json`. */
  readonly home: string;
  /** Epoch milliseconds, for the 24 hour cache age. */
  readonly now: number;
  /** Ignore the cache and run `agy models`. */
  readonly refresh: boolean;
}

/**
 * Returns the cached catalog, refreshing it when it is missing, older than 24 hours, from
 * another agy version, or `refresh` is set. The cache is written atomically.
 * @throws {AgyUnavailable} When `agy --version` or `agy models` fails or times out.
 */
export const readAgyCatalog = (
  _options: ReadAgyCatalogOptions,
): Effect.Effect<
  AgyCatalog,
  AgyUnavailable,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Effect.die(new Error("not implemented"));
