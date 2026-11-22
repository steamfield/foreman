/**
 * agy's catalog as model families: which family an id belongs to, the efforts a family offers,
 * the effort a start defaults to, and the settings a start on a matched model runs with. Pure.
 */
import type { RoutingFailure } from "../routing-errors";
import type { AgyCatalog } from "./catalog";

/** A model id matched in agy's catalog: the family agy runs and the effort its id fixes. */
export interface AgyMatch {
  readonly family: string;
  readonly effort: string | null;
  /** The id is its own family (`gpt-oss-120b-medium`), so its effort can't be changed. */
  readonly fixed: boolean;
}

/** A family agy offers: its id, the efforts its ids add, and the effort a start defaults to. */
export interface AgyFamily {
  readonly model: string;
  readonly efforts: readonly string[];
  /** null when the model has a fixed effort. */
  readonly defaultEffort: string | null;
  /** Every id agy lists for the family, the family id included when agy lists it. */
  readonly ids: readonly string[];
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh"];
const AGY_DEFAULT_EFFORT = "high";
// The effort recorded for an agy model with a fixed effort; the connection sends its id as is.
const NO_EFFORT = "none";

/**
 * Finds `model` in agy's catalog as a full id (`gemini-4-neon-high`) or a family
 * (`gemini-4-neon`); null when agy lists neither.
 * @throws Never; pure.
 */
export function matchAgyModel(model: string, catalog: AgyCatalog): AgyMatch | null {
  const exact = catalog.models.find((entry) => entry.id === model);
  if (exact !== undefined)
    return { family: exact.family, effort: exact.effort, fixed: exact.family === exact.id };
  if (catalog.models.some((entry) => entry.family === model))
    return { family: model, effort: null, fixed: false };
  return null;
}

/**
 * The efforts agy offers for a family, lowest first; none for a model with a fixed effort.
 * @throws Never; pure.
 */
export function familyEfforts(family: string, catalog: AgyCatalog): string[] {
  const efforts = new Set<string>();
  for (const entry of catalog.models)
    if (entry.family === family && entry.id !== family && entry.effort !== null)
      efforts.add(entry.effort);
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

/**
 * "high" when the family offers it, else its highest effort; null for a fixed effort.
 * @throws Never; pure.
 */
export function defaultAgyEffort(efforts: readonly string[]): string | null {
  if (efforts.includes(AGY_DEFAULT_EFFORT)) return AGY_DEFAULT_EFFORT;
  return efforts.at(-1) ?? null;
}

/**
 * Each family in agy's catalog once, in catalog order, with its efforts, default effort and ids.
 * @throws Never; pure.
 */
export function agyFamilies(catalog: AgyCatalog): AgyFamily[] {
  const families = [...new Set(catalog.models.map((entry) => entry.family))];
  return families.map((model) => {
    const efforts = familyEfforts(model, catalog);
    const ids = catalog.models.filter((entry) => entry.family === model).map((entry) => entry.id);
    return { model, efforts, defaultEffort: defaultAgyEffort(efforts), ids };
  });
}

/** The family and effort an agy start runs with. */
export interface AgySettings {
  readonly _tag: "AgySettings";
  readonly family: string;
  readonly effort: string;
}

/**
 * The family and effort for a matched model, or why the request's effort or tier don't apply:
 * --tier never does, a suffixed id fixes its effort, and a family accepts only its efforts.
 * @throws Never; pure.
 */
export function agySettings(
  request: { readonly effort?: string; readonly tier?: string },
  model: string,
  match: AgyMatch,
  catalog: AgyCatalog,
): AgySettings | RoutingFailure {
  const { family } = match;
  if (request.tier !== undefined) return { _tag: "TierOnAgy", model: family };
  const efforts = familyEfforts(family, catalog);
  const invalid = (effort: string): RoutingFailure => ({
    _tag: "InvalidEffort",
    effort,
    model: family,
    provider: "agy",
    efforts,
  });
  if (match.effort !== null && request.effort !== undefined && request.effort !== match.effort)
    return match.fixed
      ? invalid(request.effort)
      : {
          _tag: "EffortConflict",
          model,
          family,
          modelEffort: match.effort,
          effort: request.effort,
        };
  if (match.effort === null && request.effort !== undefined) {
    const fits =
      efforts.length === 0 ? request.effort === NO_EFFORT : efforts.includes(request.effort);
    if (!fits) return invalid(request.effort);
  }
  const effort = match.effort ?? request.effort ?? defaultAgyEffort(efforts) ?? NO_EFFORT;
  return { _tag: "AgySettings", family, effort };
}
