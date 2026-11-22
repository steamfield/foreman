/**
 * The agy model catalog: `agy models` parsed into model families and effort suffixes, cached
 * under foreman's home for a day and refreshed when agy's version changes.
 */
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../../core/process";
import { AgyUnavailable, type PermissionDenied, type WorktreeInvalid } from "../../errors";
import { outputTail } from "../output-tail";

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

const AgyModelSchema = Schema.Struct({
  id: Schema.String,
  family: Schema.String,
  effort: Schema.NullOr(Schema.String),
  name: Schema.String,
});
const AgyCatalogFile = Schema.fromJsonString(
  Schema.Struct({
    fetchedAt: Schema.String,
    agyVersion: Schema.String,
    models: Schema.Array(AgyModelSchema),
  }),
);

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AGY_COMMAND_TIMEOUT = "30 seconds";

/**
 * Parses `agy models` stdout: `<id>\t<name>` lines after an optional "Fetching..." line.
 * A suffix is split off as an effort only when another model shares the remaining family;
 * an id with a single effort (`gpt-oss-120b-medium`) is its own family.
 */
export function parseAgyModels(stdout: string): AgyModel[] {
  const listed = stdout
    .split("\n")
    .map((line) => line.trimEnd().split("\t"))
    .filter((fields): fields is [string, string] => fields.length === 2 && fields[0] !== "")
    .map(([id, name]) => ({ id, name, effort: EFFORT_SUFFIX.exec(id)?.[1] ?? null }));
  const idsPerStem = new Map<string, number>();
  for (const { id, effort } of listed) {
    if (effort === null) continue;
    const stem = id.slice(0, id.length - effort.length - 1);
    idsPerStem.set(stem, (idsPerStem.get(stem) ?? 0) + 1);
  }
  return listed.map(({ id, name, effort }) => {
    const stem = effort === null ? id : id.slice(0, id.length - effort.length - 1);
    const shared = (idsPerStem.get(stem) ?? 0) > 1;
    return { id, family: shared ? stem : id, effort, name };
  });
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

const spawnFailureReason = (error: PermissionDenied | WorktreeInvalid) =>
  error._tag === "PermissionDenied"
    ? "permission denied"
    : "the executable was not found or could not start";

/** Runs `agy <args>` and returns its stdout. */
const runAgy = Effect.fnUntraced(function* (options: ReadAgyCatalogOptions, args: string[]) {
  const command = `agy ${args.join(" ")}`;
  const result = yield* commandResult(
    ChildProcess.make(options.agyBin, args, { env: options.env, extendEnv: false }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: AGY_COMMAND_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new AgyUnavailable({
            detail: `\`${command}\` didn't finish within ${AGY_COMMAND_TIMEOUT}`,
          }),
        ),
    }),
    Effect.mapError((error) =>
      error instanceof AgyUnavailable
        ? error
        : new AgyUnavailable({
            detail: `Could not run \`${command}\`: ${spawnFailureReason(error)}`,
          }),
    ),
  );
  if (result.code !== 0)
    return yield* new AgyUnavailable({
      detail: `\`${command}\` exited with code ${result.code}: ${outputTail(result.stderr).trim() || "no stderr"}`,
    });
  return result.stdout;
});

/** The cache file's path under foreman's home. */
const cachePath = (path: Path.Path, home: string) =>
  path.join(home, "providers", "agy", "models.json");

/** The catalog in the cache file when it is less than a day old, else undefined. */
const readUnexpiredCache = Effect.fnUntraced(function* (cacheFile: string, now: number) {
  const fs = yield* FileSystem.FileSystem;
  const cached = yield* fs.readFileString(cacheFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AgyCatalogFile)),
    // A damaged cache counts as missing.
    Effect.orElseSucceed(() => undefined),
  );
  if (cached === undefined) return undefined;
  const age = now - Date.parse(cached.fetchedAt);
  return age >= 0 && age < CACHE_MAX_AGE_MS ? cached : undefined;
});

/** The cached catalog when it is still usable for this agy version, else undefined. */
const readFreshCache = Effect.fnUntraced(function* (
  cacheFile: string,
  agyVersion: string,
  now: number,
) {
  const cached = yield* readUnexpiredCache(cacheFile, now);
  return cached?.agyVersion === agyVersion ? cached : undefined;
});

/**
 * The cache file's catalog without running agy, so without checking agy's version; null when
 * it is missing, damaged or more than a day old.
 * @throws Never; an unusable cache is null.
 */
export const readCachedAgyCatalog = Effect.fn("agy.readCachedAgyCatalog")(function* (
  home: string,
  now: number,
) {
  const path = yield* Path.Path;
  return (yield* readUnexpiredCache(cachePath(path, home), now)) ?? null;
});

/** Writes the cache to a temporary file and renames it, so readers never see a torn file. */
const writeCache = Effect.fnUntraced(
  function* (cacheFile: string, catalog: AgyCatalog) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = `${cacheFile}.${crypto.randomUUID()}.tmp`;
    const encoded = yield* Schema.encodeEffect(AgyCatalogFile)(catalog);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(cacheFile), { recursive: true });
      yield* fs.writeFileString(temporary, encoded);
      yield* fs.rename(temporary, cacheFile);
    }).pipe(Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
  },
  Effect.mapError(
    (error) =>
      new AgyUnavailable({
        detail: `Could not write the agy model cache: ${error.message}`,
      }),
  ),
);

/**
 * Returns the cached catalog, refreshing it when it is missing, older than 24 hours, from
 * another agy version, or `refresh` is set. The cache is written atomically.
 * @throws {AgyUnavailable} When `agy --version` or `agy models` fails or times out. A cache
 * that can't be written is logged as a warning and the fetched catalog is returned.
 */
export const readAgyCatalog = Effect.fn("agy.readAgyCatalog")(function* (
  options: ReadAgyCatalogOptions,
) {
  const path = yield* Path.Path;
  const cacheFile = cachePath(path, options.home);
  const agyVersion = (yield* runAgy(options, ["--version"])).trim();
  if (!options.refresh) {
    const cached = yield* readFreshCache(cacheFile, agyVersion, options.now);
    if (cached !== undefined) return cached;
  }
  const modelsOutput = yield* runAgy(options, ["models"]);
  const models = parseAgyModels(modelsOutput);
  if (models.length === 0)
    return yield* new AgyUnavailable({
      detail: `\`agy models\` listed no models (output: ${outputTail(modelsOutput)})`,
    });
  const catalog: AgyCatalog = {
    fetchedAt: new Date(options.now).toISOString(),
    agyVersion,
    models,
  };
  // The catalog is already in hand; an unwritable cache only costs the next read a refetch.
  yield* writeCache(cacheFile, catalog).pipe(
    Effect.catchTag("AgyUnavailable", (error) =>
      Effect.logWarning("agy.catalog.cache.unwritable").pipe(
        Effect.annotateLogs({ detail: error.detail ?? "no detail" }),
      ),
    ),
  );
  return catalog;
});

/** agy's catalog, or why it couldn't be read because agy isn't installed. */
export type AgyCatalogRead =
  | { readonly _tag: "Read"; readonly catalog: AgyCatalog }
  | { readonly _tag: "NotInstalled"; readonly reason: string };

// foreman runs on macOS and Linux only.
const PATH_DELIMITER = ":";

/**
 * Why agy isn't installed, or null when its executable exists: the configured path, or a file
 * of that name in a PATH directory. Checked first because a failed spawn doesn't say whether
 * agy was missing.
 */
const missingReason = Effect.fnUntraced(function* (agyBin: string, searchPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (agyBin.includes(path.sep)) return (yield* exists(agyBin)) ? null : `${agyBin} not found`;
  for (const directory of searchPath.split(PATH_DELIMITER))
    if (directory !== "" && (yield* exists(path.join(directory, agyBin)))) return null;
  return `${agyBin} not found on PATH`;
});

/**
 * Reads agy's catalog as readAgyCatalog does, after checking that agy is installed; a missing
 * executable is a NotInstalled result rather than a failure.
 * @throws {AgyUnavailable} When agy is installed and its catalog can't be read.
 */
export const readAgyCatalogIfInstalled = Effect.fn("agy.readAgyCatalogIfInstalled")(function* (
  options: ReadAgyCatalogOptions & { readonly searchPath: string },
) {
  const reason = yield* missingReason(options.agyBin, options.searchPath);
  if (reason !== null) return { _tag: "NotInstalled", reason } satisfies AgyCatalogRead;
  const catalog = yield* readAgyCatalog(options);
  return { _tag: "Read", catalog } satisfies AgyCatalogRead;
});
