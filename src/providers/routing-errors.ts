/**
 * The errors model routing raises: one ModelUnresolved per row of docs/rfcs/0002-providers.md
 * "Model routing and its errors", with near-miss suggestions across both catalogs. Pure.
 */
import { ModelUnresolved } from "../errors";
import type { ModelCandidate } from "../schemas/models";
import type { ProviderId } from "../schemas/provider";
import type { AgyCatalog } from "./agy/catalog";
import { agyFamilies } from "./agy/models";
import type { CodexCatalog } from "./codex/catalog";

/**
 * Which catalogs an unknown model was checked against: both, the one its prefix named, or
 * Codex's alone because agy isn't installed.
 */
export type CheckedCatalogs = "both" | ProviderId | "codex-without-agy";

/** Why routing failed, with the values its message names. */
export type RoutingFailure =
  /** No checked catalog lists the input; `nearMisses` may be empty. */
  | {
      readonly _tag: "UnknownModel";
      readonly input: string;
      readonly nearMisses: readonly ModelCandidate[];
      readonly checked: CheckedCatalogs;
    }
  /** Both providers list the model; `candidates` holds one entry per provider. */
  | {
      readonly _tag: "Ambiguous";
      readonly model: string;
      readonly candidates: readonly ModelCandidate[];
    }
  /** The model's effort suffix and --effort disagree. */
  | {
      readonly _tag: "EffortConflict";
      readonly model: string;
      readonly family: string;
      readonly modelEffort: string;
      readonly effort: string;
    }
  /** --effort isn't one the model accepts; no `efforts` means the model's effort is fixed. */
  | {
      readonly _tag: "InvalidEffort";
      readonly effort: string;
      readonly model: string;
      readonly provider: ProviderId;
      readonly efforts: readonly string[];
    }
  /** --tier on a model that runs on agy. */
  | { readonly _tag: "TierOnAgy"; readonly model: string }
  /** `<prefix>:model` names no provider. */
  | { readonly _tag: "UnknownProvider"; readonly prefix: string; readonly input: string }
  /**
   * A catalog couldn't be read and no other catalog lists the input. `installed` is false
   * when the provider's executable is missing, which changes the next step.
   */
  | {
      readonly _tag: "CatalogUnavailable";
      readonly model: string;
      readonly provider: ProviderId;
      readonly reason: string;
      readonly installed: boolean;
    }
  /** Codex lists the model without `visibility: "list"`. */
  | { readonly _tag: "HiddenCodexModel"; readonly model: string };

/** A model near misses are scored against: the candidate and every id that names it. */
export interface NearMissOption {
  readonly candidate: ModelCandidate;
  /** Other ids for the model, such as agy's suffixed `gemini-4-neon-high`. */
  readonly ids: readonly string[];
}

const MAX_EDIT_DISTANCE = 2;
// Enough choices for an agent to act on; a short prefix could otherwise match every model.
const MAX_NEAR_MISSES = 5;
const MODELS_HINT = "Run foreman models to see the available models.";
const NEAR_MISS_HINT = "Run foreman models to see every model.";
const INSTALL_HINTS: Record<ProviderId, string> = {
  codex: "Install Codex or set CODEX_BIN.",
  agy: "Install agy or set AGY_BIN.",
};
const DOCTOR_HINT = "Run foreman doctor.";
// Why a model checked against one catalog is unknown; "both" depends on the near miss.
const SINGLE_CATALOG_REASONS: Record<Exclude<CheckedCatalogs, "both">, string> = {
  codex: "codex doesn't list it",
  agy: "agy doesn't list it",
  "codex-without-agy": "codex doesn't list it and agy isn't installed",
};

/** The Levenshtein distance between two strings: inserts, deletes and substitutions. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [row, leftChar] of [...left].entries()) {
    const current = [row + 1];
    for (const [column, rightChar] of [...right].entries()) {
      const substitution = (previous[column] ?? 0) + (leftChar === rightChar ? 0 : 1);
      const deletion = (previous[column + 1] ?? 0) + 1;
      const insertion = (current[column] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** The option's closest distance to `input` when one of its ids is a near miss, else null. */
function nearMissDistance(input: string, option: NearMissOption): number | null {
  const names = [option.candidate.model, ...option.ids];
  if (names.includes(input)) return null;
  const close = names.some(
    (name) => name.startsWith(input) || editDistance(input, name) <= MAX_EDIT_DISTANCE,
  );
  return close ? Math.min(...names.map((name) => editDistance(input, name))) : null;
}

/**
 * The catalog models with an id within edit distance 2 of `input`, or starting with it, closest
 * first and at most five. Ties keep catalog order.
 * @throws Never; pure.
 */
export function nearMisses(
  input: string,
  catalog: readonly NearMissOption[],
): readonly ModelCandidate[] {
  const scored = catalog.flatMap((option) => {
    const distance = nearMissDistance(input, option);
    return distance === null ? [] : [{ candidate: option.candidate, distance }];
  });
  // Array.prototype.sort is stable, so equal distances keep catalog order.
  scored.sort((left, right) => left.distance - right.distance);
  return scored.slice(0, MAX_NEAR_MISSES).map(({ candidate }) => candidate);
}

/** The unknown-model sentence: what wasn't found, the closest model if any, and where to look. */
function unknownModelDetail(failure: Extract<RoutingFailure, { _tag: "UnknownModel" }>): string {
  const subject = `Unknown model ${JSON.stringify(failure.input)}`;
  const [closest] = failure.nearMisses;
  const bothReason =
    closest === undefined ? "neither codex nor agy lists it" : "no provider lists it";
  const reason = failure.checked === "both" ? bothReason : SINGLE_CATALOG_REASONS[failure.checked];
  if (closest === undefined) return `${subject}: ${reason}. ${MODELS_HINT}`;
  return `${subject}: ${reason}. Did you mean ${closest.model} (${closest.provider})? ${NEAR_MISS_HINT}`;
}

/** The catalog-unavailable sentence: the provider, the cause and the one next step. */
function catalogUnavailableDetail(
  failure: Extract<RoutingFailure, { _tag: "CatalogUnavailable" }>,
): string {
  const hint = failure.installed ? DOCTOR_HINT : INSTALL_HINTS[failure.provider];
  return `Can't check model ${JSON.stringify(failure.model)}: ${failure.provider} is unavailable (${failure.reason}). ${hint}`;
}

/** The invalid-effort sentence: the efforts to pick from, or that the effort is fixed. */
function invalidEffortDetail(failure: Extract<RoutingFailure, { _tag: "InvalidEffort" }>): string {
  const subject = `--effort ${failure.effort} is not valid for ${failure.model} (${failure.provider})`;
  if (failure.efforts.length === 0) return `${subject}, which has a fixed effort. Remove --effort.`;
  return `${subject}. Use one of: ${failure.efforts.join(", ")}.`;
}

/** The message for a failure, worded as the RFC table says. */
function failureDetail(failure: RoutingFailure): string {
  switch (failure._tag) {
    case "UnknownModel":
      return unknownModelDetail(failure);
    case "Ambiguous":
      return `Model ${JSON.stringify(failure.model)} is offered by codex and agy. Pass --model codex:${failure.model} or --model agy:${failure.model}.`;
    case "EffortConflict":
      return `--model ${failure.model} sets effort ${failure.modelEffort}, but --effort is ${failure.effort}. Use --model ${failure.family} --effort ${failure.effort}.`;
    case "InvalidEffort":
      return invalidEffortDetail(failure);
    case "TierOnAgy":
      return `--tier only applies to Codex models; ${failure.model} runs on agy. Remove --tier.`;
    case "UnknownProvider":
      return `Unknown provider ${JSON.stringify(failure.prefix)} in --model ${failure.input}. Use codex or agy.`;
    case "CatalogUnavailable":
      return catalogUnavailableDetail(failure);
    case "HiddenCodexModel":
      return `Model ${JSON.stringify(failure.model)} is in Codex's catalog but hidden. Pick a visible model from foreman models.`;
  }
}

/** The models an agent could pass instead, for the --json envelope; none when there are none. */
function failureCandidates(failure: RoutingFailure): readonly ModelCandidate[] {
  switch (failure._tag) {
    case "UnknownModel":
      return failure.nearMisses;
    case "Ambiguous":
      return failure.candidates;
    case "InvalidEffort":
      return failure.efforts.length === 0
        ? []
        : [{ provider: failure.provider, model: failure.model, efforts: failure.efforts }];
    default:
      return [];
  }
}

const agyOptions = (catalog: AgyCatalog): NearMissOption[] =>
  agyFamilies(catalog).map(({ model, efforts, ids }) => ({
    candidate: { provider: "agy", model, efforts },
    ids,
  }));

const codexOptions = (catalog: CodexCatalog): NearMissOption[] =>
  catalog.listed.map(({ model, efforts }) => ({
    candidate: { provider: "codex", model, efforts },
    ids: [],
  }));

/**
 * The failure for a model only one catalog was checked for: near misses from that catalog.
 * @throws Never; pure.
 */
export function unknownInOneCatalog(
  model: string,
  catalog:
    | { readonly provider: "agy"; readonly catalog: AgyCatalog }
    | { readonly provider: "codex"; readonly catalog: CodexCatalog },
): RoutingFailure {
  const options =
    catalog.provider === "agy" ? agyOptions(catalog.catalog) : codexOptions(catalog.catalog);
  const misses = nearMisses(model, options);
  return { _tag: "UnknownModel", input: model, nearMisses: misses, checked: catalog.provider };
}

/**
 * The failure for a model agy's catalog couldn't vouch for, because agy is missing or failing.
 * @throws Never; pure.
 */
export function agyUnavailable(model: string, reason: string, installed: boolean): RoutingFailure {
  return { _tag: "CatalogUnavailable", model, provider: "agy", reason, installed };
}

/** What reading agy's catalog gave for a bare model that agy didn't resolve. */
export type AgyOutcome =
  | { readonly _tag: "NotInstalled"; readonly reason: string }
  | { readonly _tag: "Failed"; readonly reason: string }
  | { readonly _tag: "Read"; readonly catalog: AgyCatalog };

/**
 * The failure for a bare model neither catalog resolved. A missing agy only narrows the check
 * to Codex; a failing agy wins unless Codex has a near miss, so a Codex typo never blames agy.
 * @throws Never; pure.
 */
export function unresolvedBareModel(
  model: string,
  codex: CodexCatalog,
  agy: AgyOutcome,
): RoutingFailure {
  const codexMisses = nearMisses(model, codexOptions(codex));
  if (agy._tag === "NotInstalled")
    return {
      _tag: "UnknownModel",
      input: model,
      nearMisses: codexMisses,
      checked: "codex-without-agy",
    };
  if (agy._tag === "Failed")
    return codexMisses.length === 0
      ? agyUnavailable(model, agy.reason, true)
      : { _tag: "UnknownModel", input: model, nearMisses: codexMisses, checked: "codex" };
  const both = [...codexOptions(codex), ...agyOptions(agy.catalog)];
  const misses = nearMisses(model, both);
  return { _tag: "UnknownModel", input: model, nearMisses: misses, checked: "both" };
}

/**
 * The ModelUnresolved error for a failure, worded as the RFC table says, with the models the
 * input likely meant as `candidates`.
 * @throws Never; returns the error for the caller to fail with.
 */
export function routingError(failure: RoutingFailure): ModelUnresolved {
  const candidates = failureCandidates(failure);
  return new ModelUnresolved({
    detail: failureDetail(failure),
    ...(candidates.length === 0 ? {} : { candidates }),
  });
}
