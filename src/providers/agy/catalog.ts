/**
 * The agy model catalog: `agy models` parsed into model families and effort suffixes, cached
 * under foreman's home for a day and refreshed when agy's version changes.
 */
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../../core/process";
import { AgyUnavailable } from "../../errors";
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

/** Runs `agy <args>` and returns its stdout. */
const runAgy = Effect.fnUntraced(function* (options: ReadAgyCatalogOptions, args: string[]) {
  const command = `${options.agyBin} ${args.join(" ")}`;
  const unavailable = (reason: string) =>
    new AgyUnavailable({
      detail: `\`${command}\` ${reason}. Install agy or set AGY_BIN, then run foreman doctor.`,
    });
  const result = yield* commandResult(
    ChildProcess.make(options.agyBin, args, { env: options.env, extendEnv: false }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: AGY_COMMAND_TIMEOUT,
      orElse: () => Effect.fail(unavailable(`didn't finish within ${AGY_COMMAND_TIMEOUT}`)),
    }),
    Effect.mapError((error) =>
      error instanceof AgyUnavailable ? error : unavailable(`couldn't run: ${error.detail}`),
    ),
  );
  if (result.code !== 0)
    return yield* unavailable(`exited with code ${result.code}: ${outputTail(result.stderr)}`);
  return result.stdout;
});

/** The cached catalog when it is still usable, else undefined. A damaged cache counts as missing. */
const readFreshCache = Effect.fnUntraced(function* (
  cacheFile: string,
  agyVersion: string,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const cached = yield* fs.readFileString(cacheFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AgyCatalogFile)),
    Effect.orElseSucceed(() => undefined),
  );
  if (cached === undefined || cached.agyVersion !== agyVersion) return undefined;
  const age = now - Date.parse(cached.fetchedAt);
  return age >= 0 && age < CACHE_MAX_AGE_MS ? cached : undefined;
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
        detail: `Could not write the agy model cache: ${error.message}. Check that foreman's home is writable, then retry.`,
      }),
  ),
);

/**
 * Returns the cached catalog, refreshing it when it is missing, older than 24 hours, from
 * another agy version, or `refresh` is set. The cache is written atomically.
 * @throws {AgyUnavailable} When `agy --version` or `agy models` fails or times out, or the
 * cache can't be written.
 */
export const readAgyCatalog = Effect.fn("agy.readAgyCatalog")(function* (
  options: ReadAgyCatalogOptions,
) {
  const path = yield* Path.Path;
  const cacheFile = path.join(options.home, "providers", "agy", "models.json");
  const agyVersion = (yield* runAgy(options, ["--version"])).trim();
  if (!options.refresh) {
    const cached = yield* readFreshCache(cacheFile, agyVersion, options.now);
    if (cached !== undefined) return cached;
  }
  const models = parseAgyModels(yield* runAgy(options, ["models"]));
  const catalog: AgyCatalog = {
    fetchedAt: new Date(options.now).toISOString(),
    agyVersion,
    models,
  };
  yield* writeCache(cacheFile, catalog);
  return catalog;
});
