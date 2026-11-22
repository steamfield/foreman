/**
 * Model routing: which provider runs a start, from the model it names. docs/rfcs/0002-providers.md
 * "Model routing and its errors" is the rule set and the error wording.
 *
 * Rules, in order: `provider:model` picks that provider; an exact id in Codex's catalog picks
 * Codex, unless agy's cached catalog lists it too; otherwise agy's catalog is read and an exact
 * id or family there picks agy, with an effort suffix split off the id. A model in neither
 * catalog refreshes agy's catalog once when it is more than an hour old. No model keeps today's
 * Codex default. The catalogs are passed in, so the rules themselves do no I/O.
 */
import { Clock, Effect } from "effect";
import type { AgyUnavailable, ModelUnresolved } from "../errors";
import type { ModelCandidate } from "../schemas/models";
import type { ProviderId } from "../schemas/provider";
import type { AgyCatalog } from "./agy/catalog";
import { nearMisses, type RoutingFailure, routingError } from "./routing-errors";

/** What the start asked for. */
export interface ModelRequest {
  readonly model?: string;
  readonly effort?: string;
  readonly tier?: string;
}

/** Where the start goes and with what settings; omitted fields keep today's Codex defaults. */
export interface RoutedModel {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly effort?: string;
  readonly tier?: string;
}

/** A model Codex lists, with the reasoning efforts its cache entry declares. */
export interface CodexModel {
  readonly model: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
}

/** The models in Codex's catalog, by visibility. */
export interface CodexCatalog {
  /** Models Codex shows (`visibility: "list"`); empty when the catalog can't be read. */
  readonly listed: readonly CodexModel[];
  /** Ids present without `visibility: "list"`. */
  readonly hidden: readonly string[];
}

/** The catalogs routing consults, read lazily: agy's only when a rule needs it. */
export interface ModelCatalogs {
  readonly codex: Effect.Effect<CodexCatalog>;
  /** agy's cache file as last written, without running agy; null when missing or stale. */
  readonly agyCached: Effect.Effect<AgyCatalog | null>;
  /**
   * agy's catalog, from its cache or `agy models`; `refresh` forces `agy models`. Fails with
   * the reason agy is unavailable, including when it isn't installed.
   */
  readonly agy: (refresh: boolean) => Effect.Effect<AgyCatalog, AgyUnavailable>;
}

/** A family agy offers: its id, the efforts its ids add, and the effort a start defaults to. */
export interface AgyFamily {
  readonly model: string;
  readonly efforts: readonly string[];
  /** null when the model has a fixed effort. */
  readonly defaultEffort: string | null;
}

const PROVIDERS: readonly ProviderId[] = ["codex", "agy"];
const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];
const AGY_DEFAULT_EFFORT = "high";
// The effort recorded for an agy model with a fixed effort; the connection sends its id as is.
const NO_EFFORT = "none";
const AGY_REFRESH_AGE_MS = 60 * 60 * 1000;

/** A model id matched in agy's catalog: the family agy runs and the effort its id fixes. */
interface AgyMatch {
  readonly family: string;
  readonly effort: string | null;
  /** The id is its own family (`gpt-oss-120b-medium`), so its effort can't be changed. */
  readonly fixed: boolean;
}

const fail = (failure: RoutingFailure) => Effect.fail(routingError(failure));

/** Codex keeps the request as given: Codex itself checks effort and tier. */
function codexRoute(request: ModelRequest, model: string | undefined): RoutedModel {
  return {
    provider: "codex",
    ...(model === undefined ? {} : { model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.tier === undefined ? {} : { tier: request.tier }),
  };
}

/** Finds `model` in agy's catalog as a full id (`gemini-4-neon-high`) or a family (`gemini-4-neon`). */
function matchAgyModel(model: string, catalog: AgyCatalog): AgyMatch | null {
  const exact = catalog.models.find((entry) => entry.id === model);
  if (exact !== undefined)
    return { family: exact.family, effort: exact.effort, fixed: exact.family === exact.id };
  if (catalog.models.some((entry) => entry.family === model))
    return { family: model, effort: null, fixed: false };
  return null;
}

/** The efforts agy offers for a family, lowest first; none for a model with a fixed effort. */
function familyEfforts(family: string, catalog: AgyCatalog): string[] {
  const efforts = new Set<string>();
  for (const entry of catalog.models)
    if (entry.family === family && entry.id !== family && entry.effort !== null)
      efforts.add(entry.effort);
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

/** "high" when the family offers it, else its highest effort; null for a fixed effort. */
function defaultAgyEffort(efforts: readonly string[]): string | null {
  if (efforts.includes(AGY_DEFAULT_EFFORT)) return AGY_DEFAULT_EFFORT;
  return efforts.at(-1) ?? null;
}

/**
 * Each family in agy's catalog once, in catalog order, with its efforts and default effort.
 * @throws Never; pure.
 */
export function agyFamilies(catalog: AgyCatalog): AgyFamily[] {
  const families = [...new Set(catalog.models.map((entry) => entry.family))];
  return families.map((model) => {
    const efforts = familyEfforts(model, catalog);
    return { model, efforts, defaultEffort: defaultAgyEffort(efforts) };
  });
}

const agyCandidates = (catalog: AgyCatalog): ModelCandidate[] =>
  agyFamilies(catalog).map(({ model, efforts }) => ({ provider: "agy", model, efforts }));

const codexCandidates = (catalog: CodexCatalog): ModelCandidate[] =>
  catalog.listed.map(({ model, efforts }) => ({ provider: "codex", model, efforts }));

/** The failure for an effort that doesn't fit the family, or null when it does. */
function effortFailure(
  effort: string,
  family: string,
  efforts: readonly string[],
): RoutingFailure | null {
  const fits = efforts.length === 0 ? effort === NO_EFFORT : efforts.includes(effort);
  return fits ? null : { _tag: "InvalidEffort", effort, model: family, provider: "agy", efforts };
}

/**
 * The agy settings for a matched model: family, effort and no tier.
 * @throws {ModelUnresolved} When --tier is set, or the effort conflicts with the model or the
 * family.
 */
function agyRoute(
  request: ModelRequest,
  model: string,
  match: AgyMatch,
  catalog: AgyCatalog,
): Effect.Effect<RoutedModel, ModelUnresolved> {
  const { family } = match;
  if (request.tier !== undefined) return fail({ _tag: "TierOnAgy", model: family });
  const efforts = familyEfforts(family, catalog);
  if (match.effort !== null && request.effort !== undefined && request.effort !== match.effort)
    return fail(
      match.fixed
        ? { _tag: "InvalidEffort", effort: request.effort, model: family, provider: "agy", efforts }
        : {
            _tag: "EffortConflict",
            model,
            family,
            modelEffort: match.effort,
            effort: request.effort,
          },
    );
  if (match.effort === null && request.effort !== undefined) {
    const failure = effortFailure(request.effort, family, efforts);
    if (failure !== null) return fail(failure);
  }
  const effort = match.effort ?? request.effort ?? defaultAgyEffort(efforts) ?? NO_EFFORT;
  return Effect.succeed({ provider: "agy", model: family, effort });
}

/**
 * Reads agy's catalog and matches `model` in it, refreshing once when the model isn't there
 * and the catalog is more than an hour old.
 * @throws {AgyUnavailable} When agy isn't installed or its catalog can't be read.
 */
const findInAgy = Effect.fnUntraced(function* (model: string, catalogs: ModelCatalogs) {
  const cached = yield* catalogs.agy(false);
  const match = matchAgyModel(model, cached);
  const now = yield* Clock.currentTimeMillis;
  if (match !== null || now - Date.parse(cached.fetchedAt) <= AGY_REFRESH_AGE_MS)
    return { catalog: cached, match };
  const refreshed = yield* catalogs.agy(true);
  return { catalog: refreshed, match: matchAgyModel(model, refreshed) };
});

/** The failure for a model that agy, the one catalog checked, couldn't vouch for. */
const agyUnavailable = (model: string, error: AgyUnavailable): RoutingFailure => ({
  _tag: "CatalogUnavailable",
  model,
  unavailable: [{ provider: "agy", reason: error.detail ?? "no detail" }],
});

/**
 * Routes `agy:model`, which only agy's catalog may resolve.
 * @throws {ModelUnresolved} When agy is unavailable, doesn't list the model, or its settings
 * don't apply.
 */
const routePrefixedAgy = Effect.fnUntraced(function* (
  request: ModelRequest,
  model: string,
  catalogs: ModelCatalogs,
) {
  const found = yield* findInAgy(model, catalogs).pipe(
    Effect.mapError((error) => routingError(agyUnavailable(model, error))),
  );
  if (found.match === null) {
    const misses = nearMisses(model, agyCandidates(found.catalog));
    return yield* fail({ _tag: "UnknownModel", input: model, nearMisses: misses, provider: "agy" });
  }
  return yield* agyRoute(request, model, found.match, found.catalog);
});

/**
 * Routes `codex:model`, which only Codex's catalog may resolve. An unreadable catalog passes
 * the model through, as foreman did before routing.
 * @throws {ModelUnresolved} When Codex's catalog doesn't list the model, or hides it.
 */
const routePrefixedCodex = Effect.fnUntraced(function* (
  request: ModelRequest,
  model: string,
  catalogs: ModelCatalogs,
) {
  const codex = yield* catalogs.codex;
  if (codex.hidden.includes(model)) return yield* fail({ _tag: "HiddenCodexModel", model });
  const listed = codex.listed.some((entry) => entry.model === model);
  if (codex.listed.length > 0 && !listed) {
    const misses = nearMisses(model, codexCandidates(codex));
    return yield* fail({
      _tag: "UnknownModel",
      input: model,
      nearMisses: misses,
      provider: "codex",
    });
  }
  return codexRoute(request, model);
});

/**
 * Routes a model Codex lists, unless agy's cache file lists it too. Only the cache is read, so
 * a Codex start never runs agy; a missing or stale cache skips the check.
 * @throws {ModelUnresolved} When agy's cached catalog lists the model too.
 */
const routeCodexListed = Effect.fnUntraced(function* (
  request: ModelRequest,
  codexModel: CodexModel,
  catalogs: ModelCatalogs,
) {
  const cached = yield* catalogs.agyCached;
  const match = cached === null ? null : matchAgyModel(codexModel.model, cached);
  if (cached === null || match === null) return codexRoute(request, codexModel.model);
  const agyEfforts = match.family === codexModel.model ? familyEfforts(match.family, cached) : [];
  return yield* fail({
    _tag: "Ambiguous",
    model: codexModel.model,
    candidates: [
      { provider: "codex", model: codexModel.model, efforts: codexModel.efforts },
      { provider: "agy", model: codexModel.model, efforts: agyEfforts },
    ],
  });
});

/**
 * Routes a bare model id: Codex's catalog first, then agy's. When Codex's catalog can't be
 * read, a model agy can't resolve goes to Codex unchecked, so Codex-only setups keep working.
 * A near miss in Codex's catalog wins over agy being unavailable, so a Codex typo never asks
 * for agy.
 * @throws {ModelUnresolved} When the model is ambiguous, hidden, in neither catalog, agy's
 * catalog is needed and unavailable, or agy's settings don't apply.
 */
const routeBare = Effect.fnUntraced(function* (
  request: ModelRequest,
  model: string,
  catalogs: ModelCatalogs,
) {
  const codex = yield* catalogs.codex;
  const codexModel = codex.listed.find((entry) => entry.model === model);
  if (codexModel !== undefined) return yield* routeCodexListed(request, codexModel, catalogs);
  if (codex.hidden.includes(model)) return yield* fail({ _tag: "HiddenCodexModel", model });
  const agy = yield* findInAgy(model, catalogs).pipe(Effect.result);
  if (agy._tag === "Success" && agy.success.match !== null)
    return yield* agyRoute(request, model, agy.success.match, agy.success.catalog);
  if (codex.listed.length === 0) return codexRoute(request, model);
  const codexOptions = codexCandidates(codex);
  if (agy._tag === "Failure") {
    const misses = nearMisses(model, codexOptions);
    if (misses.length === 0) return yield* fail(agyUnavailable(model, agy.failure));
    return yield* fail({ _tag: "UnknownModel", input: model, nearMisses: misses });
  }
  const both = [...codexOptions, ...agyCandidates(agy.success.catalog)];
  return yield* fail({ _tag: "UnknownModel", input: model, nearMisses: nearMisses(model, both) });
});

/**
 * Splits `provider:model`. Returns null when the model names no provider.
 * @throws {ModelUnresolved} When the prefix isn't a known provider.
 */
function splitProvider(
  model: string,
): Effect.Effect<{ provider: ProviderId; id: string } | null, ModelUnresolved> {
  const colon = model.indexOf(":");
  if (colon === -1) return Effect.succeed(null);
  const prefix = model.slice(0, colon);
  const provider = PROVIDERS.find((known) => known === prefix);
  if (provider === undefined) return fail({ _tag: "UnknownProvider", prefix, input: model });
  return Effect.succeed({ provider, id: model.slice(colon + 1) });
}

/**
 * Resolves a start's model to a provider.
 * @throws {ModelUnresolved} When the model is unknown, ambiguous, hidden or can't be checked,
 * or the effort or tier don't apply.
 */
export const resolveModel = (
  request: ModelRequest,
  catalogs: ModelCatalogs,
): Effect.Effect<RoutedModel, ModelUnresolved> =>
  Effect.gen(function* () {
    if (request.model === undefined) return codexRoute(request, undefined);
    const prefixed = yield* splitProvider(request.model);
    if (prefixed === null) return yield* routeBare(request, request.model, catalogs);
    if (prefixed.provider === "agy") return yield* routePrefixedAgy(request, prefixed.id, catalogs);
    return yield* routePrefixedCodex(request, prefixed.id, catalogs);
  });
