/**
 * Model routing: which provider runs a start, from the model it names. docs/rfcs/0002-providers.md
 * "Model routing and its errors" is the rule set and the error wording.
 *
 * Rules, in order: `provider:model` picks that provider; an exact id in Codex's catalog picks
 * Codex; otherwise agy's catalog is read and an exact id or family there picks agy, with an
 * effort suffix split off the id. No model keeps today's Codex default. The catalogs are passed
 * in, so the rules themselves do no I/O.
 */
import { Effect } from "effect";
import { AgyUnavailable, Usage } from "../errors";
import type { ProviderId } from "../schemas/provider";
import type { AgyCatalog } from "./agy/catalog";

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

/** The catalogs routing consults, read lazily: agy's only when Codex's doesn't list the model. */
export interface ModelCatalogs {
  /** Model ids Codex lists; empty when Codex's catalog can't be read. */
  readonly codex: Effect.Effect<readonly string[]>;
  readonly agy: Effect.Effect<AgyCatalog, AgyUnavailable>;
}

const PROVIDERS: readonly ProviderId[] = ["codex", "agy"];
const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];
const AGY_DEFAULT_EFFORT = "high";
const MODELS_HINT = "Run foreman models to see the available models.";

/** A model id matched in agy's catalog: the family agy runs and the effort its id fixes. */
interface AgyMatch {
  readonly family: string;
  readonly effort: string | null;
}

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
 * Splits `provider:model`. Returns null when the model names no provider.
 * @throws {Usage} When the prefix isn't a known provider.
 */
function splitProvider(
  model: string,
): Effect.Effect<{ provider: ProviderId; id: string } | null, Usage> {
  const colon = model.indexOf(":");
  if (colon === -1) return Effect.succeed(null);
  const prefix = model.slice(0, colon);
  const provider = PROVIDERS.find((known) => known === prefix);
  if (provider === undefined)
    return Effect.fail(
      new Usage({
        detail: `Unknown provider ${JSON.stringify(prefix)} in --model ${model}. Use codex or agy.`,
      }),
    );
  return Effect.succeed({ provider, id: model.slice(colon + 1) });
}

/** Finds `model` in agy's catalog as a full id (`gemini-4-neon-high`) or a family (`gemini-4-neon`). */
function matchAgyModel(model: string, catalog: AgyCatalog): AgyMatch | null {
  const exact = catalog.models.find((entry) => entry.id === model);
  if (exact !== undefined) return { family: exact.family, effort: exact.effort };
  if (catalog.models.some((entry) => entry.family === model))
    return { family: model, effort: null };
  return null;
}

/** The efforts agy offers for a family, lowest first. */
function familyEfforts(family: string, catalog: AgyCatalog): string[] {
  const efforts = new Set<string>();
  for (const entry of catalog.models)
    if (entry.family === family && entry.effort !== null) efforts.add(entry.effort);
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

/** "high" when the family offers it (or offers no efforts), else its highest effort. */
function defaultAgyEffort(efforts: readonly string[]): string {
  if (efforts.length === 0 || efforts.includes(AGY_DEFAULT_EFFORT)) return AGY_DEFAULT_EFFORT;
  return efforts.at(-1) ?? AGY_DEFAULT_EFFORT;
}

/** The Usage message when the requested effort doesn't fit the family, or null when it does. */
function effortProblem(effort: string, family: string, efforts: readonly string[]): string | null {
  if (efforts.length === 0)
    return `--effort ${effort} is not valid for ${family} (agy), which has a fixed effort. Remove --effort.`;
  if (efforts.includes(effort)) return null;
  return `--effort ${effort} is not valid for ${family} (agy). Use one of: ${efforts.join(", ")}.`;
}

/**
 * The agy settings for a matched model: family, effort and no tier.
 * @throws {Usage} When --tier is set, or the effort conflicts with the model or the family.
 */
function agyRoute(
  request: ModelRequest,
  model: string,
  match: AgyMatch,
  catalog: AgyCatalog,
): Effect.Effect<RoutedModel, Usage> {
  const { family } = match;
  const usage = (detail: string) => Effect.fail(new Usage({ detail }));
  if (request.tier !== undefined)
    return usage(`--tier only applies to Codex models; ${family} runs on agy. Remove --tier.`);
  if (match.effort !== null && request.effort !== undefined && request.effort !== match.effort)
    return usage(
      `--model ${model} sets effort ${match.effort}, but --effort is ${request.effort}. Use --model ${family} --effort ${request.effort}.`,
    );
  const efforts = familyEfforts(family, catalog);
  const requested = match.effort ?? request.effort;
  if (requested !== undefined && match.effort === null) {
    const problem = effortProblem(requested, family, efforts);
    if (problem !== null) return usage(problem);
  }
  return Effect.succeed({
    provider: "agy",
    model: family,
    effort: requested ?? defaultAgyEffort(efforts),
  });
}

/**
 * Reads agy's catalog for `model`, naming the model in the failure.
 * @throws {AgyUnavailable} When the catalog can't be read.
 */
function readAgyCatalogFor(model: string, catalogs: ModelCatalogs) {
  return catalogs.agy.pipe(
    Effect.mapError(
      (error) =>
        new AgyUnavailable({
          detail: `Can't check model ${JSON.stringify(model)}: agy is unavailable (${error.detail ?? "no detail"}). Install agy or set AGY_BIN, then run foreman doctor.`,
        }),
    ),
  );
}

/**
 * Routes `agy:model`, which only agy's catalog may resolve.
 * @throws {Usage} When agy doesn't list the model, or its settings don't apply.
 * @throws {AgyUnavailable} When agy's catalog can't be read.
 */
const routePrefixedAgy = Effect.fnUntraced(function* (
  request: ModelRequest,
  model: string,
  catalogs: ModelCatalogs,
) {
  const catalog = yield* readAgyCatalogFor(model, catalogs);
  const match = matchAgyModel(model, catalog);
  if (match === null)
    return yield* new Usage({
      detail: `Unknown model ${JSON.stringify(model)}: agy doesn't list it. ${MODELS_HINT}`,
    });
  return yield* agyRoute(request, model, match, catalog);
});

/**
 * Routes `codex:model`, which only Codex's catalog may resolve. An unreadable catalog passes
 * the model through, as foreman did before routing.
 * @throws {Usage} When Codex's catalog doesn't list the model.
 */
const routePrefixedCodex = Effect.fnUntraced(function* (
  request: ModelRequest,
  model: string,
  catalogs: ModelCatalogs,
) {
  const listed = yield* catalogs.codex;
  if (listed.length > 0 && !listed.includes(model))
    return yield* new Usage({
      detail: `Unknown model ${JSON.stringify(model)}: codex doesn't list it. ${MODELS_HINT}`,
    });
  return codexRoute(request, model);
});

/**
 * Routes a bare model id: Codex's catalog first, then agy's. When Codex's catalog can't be
 * read, a model agy can't resolve goes to Codex unchecked, so Codex-only setups keep working.
 * @throws {Usage} When neither catalog lists the model, or agy's settings don't apply.
 * @throws {AgyUnavailable} When agy's catalog is needed, can't be read, and Codex's was read.
 */
const routeBare = Effect.fnUntraced(function* (
  request: ModelRequest,
  model: string,
  catalogs: ModelCatalogs,
) {
  const listed = yield* catalogs.codex;
  if (listed.includes(model)) return codexRoute(request, model);
  const codexUnchecked = listed.length === 0;
  const agy = yield* readAgyCatalogFor(model, catalogs).pipe(Effect.result);
  if (agy._tag === "Failure") {
    if (codexUnchecked) return codexRoute(request, model);
    return yield* agy.failure;
  }
  const match = matchAgyModel(model, agy.success);
  if (match !== null) return yield* agyRoute(request, model, match, agy.success);
  if (codexUnchecked) return codexRoute(request, model);
  return yield* new Usage({
    detail: `Unknown model ${JSON.stringify(model)}: neither codex nor agy lists it. ${MODELS_HINT}`,
  });
});

/**
 * Resolves a start's model to a provider.
 * @throws {Usage} When the model is unknown, or the effort or tier don't apply.
 * @throws {AgyUnavailable} When agy's catalog is needed and can't be read.
 */
export const resolveModel = (
  request: ModelRequest,
  catalogs: ModelCatalogs,
): Effect.Effect<RoutedModel, Usage | AgyUnavailable> =>
  Effect.gen(function* () {
    if (request.model === undefined) return codexRoute(request, undefined);
    const prefixed = yield* splitProvider(request.model);
    if (prefixed === null) return yield* routeBare(request, request.model, catalogs);
    if (prefixed.provider === "agy") return yield* routePrefixedAgy(request, prefixed.id, catalogs);
    return yield* routePrefixedCodex(request, prefixed.id, catalogs);
  });
