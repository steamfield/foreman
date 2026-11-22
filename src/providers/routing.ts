/**
 * Model routing: which provider runs a start, from the model it names. docs/rfcs/0002-providers.md
 * "Model routing and its errors" is the rule set and the error wording.
 *
 * Rules, in order: `provider:model` picks that provider; an exact id in Codex's catalog picks
 * Codex, unless agy's cached catalog lists it too; otherwise agy's catalog is read and an exact
 * id or family there picks agy, with an effort suffix split off the id. A model in neither
 * catalog refreshes agy's catalog once when it is more than an hour old. No model uses the
 * configured default model, else today's Codex default. The catalogs are passed in, so the
 * rules themselves do no I/O.
 */
import { Clock, Effect } from "effect";
import type { AgyUnavailable, ModelUnresolved } from "../errors";
import type { ProviderId } from "../schemas/provider";
import type { AgyCatalog, AgyCatalogRead } from "./agy/catalog";
import { type AgyMatch, agySettings, familyEfforts, matchAgyModel } from "./agy/models";
import type { CodexCatalog, CodexModel } from "./codex/catalog";
import {
  type AgyOutcome,
  agyUnavailable,
  type RoutingFailure,
  routingError,
  unknownInOneCatalog,
  unresolvedBareModel,
} from "./routing-errors";

/** What the start asked for. */
export interface ModelRequest {
  readonly model?: string;
  readonly effort?: string;
  readonly tier?: string;
  /** `defaultModel` from config.json, used when no model is given. */
  readonly defaultModel?: string;
}

/** Where the start goes and with what settings; omitted fields keep today's Codex defaults. */
export interface RoutedModel {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly effort?: string;
  readonly tier?: string;
}

/** The catalogs routing consults, read lazily: agy's only when a rule needs it. */
export interface ModelCatalogs {
  readonly codex: Effect.Effect<CodexCatalog>;
  /** agy's cache file as last written, without running agy; null when missing or stale. */
  readonly agyCached: Effect.Effect<AgyCatalog | null>;
  /** agy's catalog, from its cache or `agy models`; `refresh` forces `agy models`. */
  readonly agy: (refresh: boolean) => Effect.Effect<AgyCatalogRead, AgyUnavailable>;
}

const PROVIDERS: readonly ProviderId[] = ["codex", "agy"];
const AGY_REFRESH_AGE_MS = 60 * 60 * 1000;

/** agy's catalog as read for one model: not installed, or the catalog and the model's match. */
type AgyLookup =
  | { readonly _tag: "NotInstalled"; readonly reason: string }
  | { readonly _tag: "Read"; readonly catalog: AgyCatalog; readonly match: AgyMatch | null };

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

/**
 * The agy route for a matched model: family, effort and no tier.
 * @throws {ModelUnresolved} When --tier is set, or the effort doesn't fit the model.
 */
function agyRoute(
  request: ModelRequest,
  model: string,
  match: AgyMatch,
  catalog: AgyCatalog,
): Effect.Effect<RoutedModel, ModelUnresolved> {
  const settings = agySettings(request, model, match, catalog);
  if (settings._tag !== "AgySettings") return fail(settings);
  return Effect.succeed({ provider: "agy", model: settings.family, effort: settings.effort });
}

/**
 * Reads agy's catalog and matches `model` in it, refreshing once when the model isn't there
 * and the catalog is more than an hour old.
 * @throws {AgyUnavailable} When agy is installed and its catalog can't be read.
 */
const findInAgy = Effect.fnUntraced(function* (model: string, catalogs: ModelCatalogs) {
  const lookup = (read: AgyCatalogRead): AgyLookup =>
    read._tag === "NotInstalled" ? read : { ...read, match: matchAgyModel(model, read.catalog) };
  const first = lookup(yield* catalogs.agy(false));
  if (first._tag === "NotInstalled" || first.match !== null) return first;
  const age = (yield* Clock.currentTimeMillis) - Date.parse(first.catalog.fetchedAt);
  if (age <= AGY_REFRESH_AGE_MS) return first;
  return lookup(yield* catalogs.agy(true));
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
    Effect.mapError((error) =>
      routingError(agyUnavailable(model, error.detail ?? "no detail", true)),
    ),
  );
  if (found._tag === "NotInstalled") return yield* fail(agyUnavailable(model, found.reason, false));
  if (found.match !== null) return yield* agyRoute(request, model, found.match, found.catalog);
  return yield* fail(unknownInOneCatalog(model, { provider: "agy", catalog: found.catalog }));
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
  if (codex.listed.length === 0 || listed) return codexRoute(request, model);
  return yield* fail(unknownInOneCatalog(model, { provider: "codex", catalog: codex }));
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
 * @throws {ModelUnresolved} When the model is ambiguous, hidden, in neither catalog, agy's
 * catalog is needed and failing, or agy's settings don't apply.
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
  const agy: AgyLookup | Extract<AgyOutcome, { _tag: "Failed" }> = yield* findInAgy(
    model,
    catalogs,
  ).pipe(
    Effect.catchTag("AgyUnavailable", (error) =>
      Effect.succeed({ _tag: "Failed", reason: error.detail ?? "no detail" } as const),
    ),
  );
  if (agy._tag === "Read" && agy.match !== null)
    return yield* agyRoute(request, model, agy.match, agy.catalog);
  if (codex.listed.length === 0) return codexRoute(request, model);
  return yield* fail(unresolvedBareModel(model, codex, agy));
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
 * Resolves a start's model, or the configured default when none is given, to a provider.
 * @throws {ModelUnresolved} When the model is unknown, ambiguous, hidden or can't be checked,
 * or the effort or tier don't apply.
 */
export const resolveModel = (
  request: ModelRequest,
  catalogs: ModelCatalogs,
): Effect.Effect<RoutedModel, ModelUnresolved> =>
  Effect.gen(function* () {
    const model = request.model ?? request.defaultModel;
    if (model === undefined) return codexRoute(request, undefined);
    const prefixed = yield* splitProvider(model);
    if (prefixed === null) return yield* routeBare(request, model, catalogs);
    if (prefixed.provider === "agy") return yield* routePrefixedAgy(request, prefixed.id, catalogs);
    return yield* routePrefixedCodex(request, prefixed.id, catalogs);
  });
