/**
 * The model catalogs start routing and `foreman models` read, from this invocation's
 * configuration, and the `foreman models` listing built from them.
 */
import { Clock, Effect, FileSystem, Path, Result, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AppConfig } from "../config";
import { AgyUnavailable } from "../errors";
import { type AgyCatalog, readAgyCatalog } from "../providers/agy/catalog";
import { agyEnvironment } from "../providers/agy/environment";
import { defaultModel, readCodexModels } from "../providers/codex/catalog";
import {
  agyFamilies,
  type CodexCatalog,
  type CodexModel,
  type ModelCatalogs,
} from "../providers/routing";
import {
  AgyCacheFile,
  CodexCacheEfforts,
  CodexCacheFile,
  type ModelsResult,
  type ProviderModels,
} from "../schemas/models";

// Listing models needs no SSH agent, so the catalog read skips the probe the daemon runs.
const NO_SSH_PROBE = { alive: true, launchdSocket: undefined };
// foreman runs on macOS and Linux only.
const PATH_DELIMITER = ":";
// Matches the agy adapter's cache lifetime; an older cache doesn't count for "listed by both".
const AGY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type CatalogServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Why agy can't run, or null when its executable exists: the configured path, or a file of
 * that name in a PATH directory. Checked here because a failed spawn doesn't say whether agy
 * was missing.
 */
const agyMissingReason = Effect.fnUntraced(function* (
  agyBin: string,
  searchPath: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  if (agyBin.includes(path.sep)) return (yield* exists(agyBin)) ? null : `${agyBin} not found`;
  for (const directory of (searchPath ?? "").split(PATH_DELIMITER))
    if (directory !== "" && (yield* exists(path.join(directory, agyBin)))) return null;
  return `${agyBin} not found on PATH`;
});

/** The efforts each Codex model declares, by slug; empty when the cache can't be read. */
const readCodexEfforts = Effect.fnUntraced(
  function* (codexHome: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(codexHome, "models_cache.json"));
    const cache = yield* Schema.decodeUnknownEffect(CodexCacheFile)(text);
    const efforts = new Map<string, Omit<CodexModel, "model">>();
    for (const entry of cache.models) {
      const decoded = Schema.decodeUnknownResult(CodexCacheEfforts)(entry);
      if (Result.isFailure(decoded)) continue;
      const { slug, default_reasoning_level, supported_reasoning_levels } = decoded.success;
      efforts.set(slug, {
        efforts: (supported_reasoning_levels ?? []).map((level) => level.effort),
        defaultEffort: default_reasoning_level ?? null,
      });
    }
    return efforts;
  },
  // A missing cache already shows as an empty catalog in readCodexModels.
  Effect.orElseSucceed(() => new Map<string, Omit<CodexModel, "model">>()),
);

/** Codex's catalog: the listed models with their efforts, and the hidden ids. */
const readCodexCatalog = Effect.fnUntraced(function* (codexHome: string) {
  const { listed, hidden } = yield* readCodexModels(codexHome);
  const efforts = yield* readCodexEfforts(codexHome);
  const catalog: CodexCatalog = {
    listed: listed.map((model) => ({
      model,
      ...(efforts.get(model) ?? { efforts: [], defaultEffort: null }),
    })),
    hidden,
  };
  return catalog;
});

/** agy's cache file when it is less than a day old, without running agy; else null. */
const readAgyCacheFile = Effect.fnUntraced(
  function* (home: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(home, "providers", "agy", "models.json");
    const cached: AgyCatalog = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AgyCacheFile)));
    const age = (yield* Clock.currentTimeMillis) - Date.parse(cached.fetchedAt);
    return age >= 0 && age < AGY_CACHE_MAX_AGE_MS ? cached : null;
  },
  // A missing or damaged cache only skips the "listed by both" check.
  Effect.orElseSucceed(() => null),
);

/**
 * The catalogs start routing and `foreman models` read, from this invocation's configuration.
 * agy runs only when a catalog effect that needs it is run.
 * @throws Never; each catalog reports its own failure when run.
 */
export const modelCatalogs = Effect.fnUntraced(function* () {
  const config = yield* AppConfig;
  const services = yield* Effect.context<CatalogServices>();
  const agy = (refresh: boolean) =>
    Effect.gen(function* () {
      const missing = yield* agyMissingReason(config.agyBin, config.inheritedEnvironment.PATH);
      if (missing !== null) return yield* new AgyUnavailable({ detail: missing });
      const env = yield* Effect.sync(() =>
        agyEnvironment(config.inheritedEnvironment, NO_SSH_PROBE),
      );
      return yield* readAgyCatalog({
        agyBin: config.agyBin,
        env,
        home: config.home,
        now: yield* Clock.currentTimeMillis,
        refresh,
      });
    }).pipe(Effect.provide(services));
  const catalogs: ModelCatalogs = {
    codex: readCodexCatalog(config.codexHome).pipe(Effect.provide(services)),
    agyCached: readAgyCacheFile(config.home).pipe(Effect.provide(services)),
    agy,
  };
  return catalogs;
});

/** Codex's models for the listing, or the reason there are none. */
function codexModels(catalog: CodexCatalog, defaultId: string, cacheFile: string): ProviderModels {
  if (catalog.listed.length === 0)
    return {
      provider: "codex",
      unavailable: `${cacheFile} is missing or lists no models; run codex once to create it`,
      models: [],
    };
  const models = catalog.listed.map((entry) => ({ ...entry, default: entry.model === defaultId }));
  return { provider: "codex", unavailable: null, models };
}

/** agy's families for the listing, or the reason agy is unavailable. */
function agyModels(catalog: Result.Result<AgyCatalog, AgyUnavailable>): ProviderModels {
  if (Result.isFailure(catalog))
    return { provider: "agy", unavailable: catalog.failure.detail ?? "no detail", models: [] };
  const models = agyFamilies(catalog.success).map((family) => ({ ...family, default: false }));
  return { provider: "agy", unavailable: null, models };
}

/**
 * Lists each provider's models with their efforts and defaults. A provider whose catalog
 * can't be read appears with the reason instead of its models.
 * @throws Never; an unavailable provider is part of the result.
 */
export const listModels = Effect.fn("models.listModels")(function* () {
  const config = yield* AppConfig;
  const path = yield* Path.Path;
  const catalogs = yield* modelCatalogs();
  const codex = yield* catalogs.codex;
  const agy = yield* catalogs.agy(false).pipe(Effect.result);
  const defaultId = yield* defaultModel(config.codexHome);
  const result: ModelsResult = {
    providers: [
      codexModels(codex, defaultId, path.join(config.codexHome, "models_cache.json")),
      agyModels(agy),
    ],
  };
  return result;
});
