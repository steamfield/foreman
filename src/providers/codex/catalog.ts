/**
 * The Codex model catalog: the models Codex lists in its `models_cache.json`, and the default
 * model picked from them.
 */
import { Effect, FileSystem, Path, Result, Schema } from "effect";

const Cache = Schema.Struct({ models: Schema.Array(Schema.Unknown) });
const Model = Schema.Struct({ visibility: Schema.Literal("list"), slug: Schema.String });
const fallback = "gpt-6.1-sol";

/** The slugs of the cache entries Codex shows in its model list, in cache order. */
function listedSlugs(models: readonly unknown[]): string[] {
  const slugs: string[] = [];
  for (const entry of models) {
    const model = Schema.decodeUnknownResult(Model)(entry);
    if (Result.isSuccess(model)) slugs.push(model.success.slug);
  }
  return slugs;
}

function newest(models: readonly unknown[]): string {
  const candidates: { slug: string; version: bigint[] }[] = [];
  for (const slug of listedSlugs(models)) {
    const match = /^gpt-([0-9]+(?:\.[0-9]+)*)-sol$/.exec(slug);
    if (match?.[1] === undefined || match[0] !== slug) continue;
    candidates.push({ slug, version: match[1].split(".").map(BigInt) });
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const left = a.version[i];
      const right = b.version[i];
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  });
  return candidates.at(-1)?.slug ?? fallback;
}

const readCache = Effect.fnUntraced(function* (codexHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(path.join(codexHome, "models_cache.json"));
  const cache = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Cache))(text);
  return cache.models;
});

/**
 * Returns the newest listed `gpt-N-sol` model in the cache under `codexHome`, or the built-in
 * fallback when the cache is missing, unreadable or lists none.
 */
export const defaultModel = Effect.fn("preflight.defaultModel")(
  function* (codexHome: string) {
    return newest(yield* readCache(codexHome));
  },
  // Cache availability never prevents starting a run.
  Effect.orElseSucceed(() => fallback),
);

const AnyModel = Schema.Struct({ slug: Schema.String });

/** The slugs of the cache entries Codex keeps out of its model list. */
function hiddenSlugs(models: readonly unknown[]): string[] {
  const listed = new Set(listedSlugs(models));
  const hidden: string[] = [];
  for (const entry of models) {
    const model = Schema.decodeUnknownResult(AnyModel)(entry);
    if (Result.isSuccess(model) && !listed.has(model.success.slug)) hidden.push(model.success.slug);
  }
  return hidden;
}

/** The reasoning fields of a cache entry; other fields are ignored. */
const ModelEfforts = Schema.Struct({
  default_reasoning_level: Schema.optionalKey(Schema.NullOr(Schema.String)),
  supported_reasoning_levels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ effort: Schema.String })),
  ),
});

/** A model Codex lists, with the reasoning efforts its cache entry declares. */
export interface CodexModel {
  readonly model: string;
  readonly efforts: readonly string[];
  /** null when the entry declares no default. */
  readonly defaultEffort: string | null;
}

/** The models in Codex's catalog, by visibility. */
export interface CodexCatalog {
  /** Models Codex shows (`visibility: "list"`), in cache order; empty when unreadable. */
  readonly listed: readonly CodexModel[];
  /** Ids present without `visibility: "list"`. */
  readonly hidden: readonly string[];
}

/** The listed models with their efforts; an entry with malformed efforts declares none. */
function listedModels(models: readonly unknown[]): CodexModel[] {
  const listed: CodexModel[] = [];
  for (const entry of models) {
    const model = Schema.decodeUnknownResult(Model)(entry);
    if (Result.isFailure(model)) continue;
    const efforts = Schema.decodeUnknownResult(ModelEfforts)(entry);
    const declared = Result.isSuccess(efforts) ? efforts.success : {};
    listed.push({
      model: model.success.slug,
      efforts: (declared.supported_reasoning_levels ?? []).map((level) => level.effort),
      defaultEffort: declared.default_reasoning_level ?? null,
    });
  }
  return listed;
}

/**
 * Returns the models in the cache under `codexHome`: the ones Codex lists
 * (`visibility: "list"`) with their efforts, and the hidden rest. A missing or unreadable cache
 * yields empty lists: routing then can't check Codex models and passes them through as it did
 * before providers existed.
 * @throws Never; an unreadable cache is an empty catalog.
 */
export const readCodexModels = Effect.fn("codex.readCodexModels")(
  function* (codexHome: string) {
    const models = yield* readCache(codexHome);
    const catalog: CodexCatalog = { listed: listedModels(models), hidden: hiddenSlugs(models) };
    return catalog;
  },
  Effect.orElseSucceed((): CodexCatalog => ({ listed: [], hidden: [] })),
);
