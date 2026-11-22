/**
 * The model catalogs start routing and `foreman models` read, from this invocation's
 * configuration, and the `foreman models` listing built from them.
 */
import { Clock, Effect, type FileSystem, Path, type Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AppConfig } from "../config";
import type { AgyUnavailable } from "../errors";
import {
  type AgyCatalogRead,
  readAgyCatalogIfInstalled,
  readCachedAgyCatalog,
} from "../providers/agy/catalog";
import { agyEnvironment } from "../providers/agy/environment";
import { agyFamilies } from "../providers/agy/models";
import { type CodexCatalog, defaultModel, readCodexModels } from "../providers/codex/catalog";
import type { ModelCatalogs } from "../providers/routing";
import type { ModelsResult, ProviderModels } from "../schemas/models";

// Listing models needs no SSH agent, so the catalog read skips the probe the daemon runs.
const NO_SSH_PROBE = { alive: true, launchdSocket: undefined };

type CatalogServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

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
      const env = yield* Effect.sync(() =>
        agyEnvironment(config.inheritedEnvironment, NO_SSH_PROBE),
      );
      return yield* readAgyCatalogIfInstalled({
        agyBin: config.agyBin,
        searchPath: config.inheritedEnvironment.PATH ?? "",
        env,
        home: config.home,
        now: yield* Clock.currentTimeMillis,
        refresh,
      });
    }).pipe(Effect.provide(services));
  const catalogs: ModelCatalogs = {
    codex: readCodexModels(config.codexHome).pipe(Effect.provide(services)),
    agyCached: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => readCachedAgyCatalog(config.home, now)),
      Effect.provide(services),
    ),
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
function agyModels(
  read: Result.Result<AgyCatalogRead, AgyUnavailable>,
  defaultId: string,
): ProviderModels {
  if (read._tag === "Failure")
    return { provider: "agy", unavailable: read.failure.detail ?? "no detail", models: [] };
  if (read.success._tag === "NotInstalled")
    return { provider: "agy", unavailable: read.success.reason, models: [] };
  const models = agyFamilies(read.success.catalog).map(
    ({ model, efforts, defaultEffort, ids }) => ({
      model,
      efforts,
      defaultEffort,
      default: model === defaultId || ids.includes(defaultId),
    }),
  );
  return { provider: "agy", unavailable: null, models };
}

/** The model a start without --model uses: config.json's `defaultModel`, else Codex's newest. */
const startDefaultModel = Effect.fnUntraced(function* () {
  const config = yield* AppConfig;
  return config.defaultModel ?? (yield* defaultModel(config.codexHome));
});

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
  const defaultId = yield* startDefaultModel();
  const result: ModelsResult = {
    providers: [
      codexModels(codex, defaultId, path.join(config.codexHome, "models_cache.json")),
      agyModels(agy, defaultId),
    ],
  };
  return result;
});
