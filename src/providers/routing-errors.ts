/**
 * The errors model routing raises: one ModelUnresolved per row of docs/rfcs/0002-providers.md
 * "Model routing and its errors", with near-miss suggestions across both catalogs. Pure.
 */
import { ModelUnresolved } from "../errors";
import type { ModelCandidate } from "../schemas/models";
import type { ProviderId } from "../schemas/provider";

/** Why routing failed, with the values its message names. */
export type RoutingFailure =
  /**
   * No catalog lists the input; `nearMisses` may be empty. `provider` is set when the input
   * named one (`agy:model`), so only that catalog was checked.
   */
  | {
      readonly _tag: "UnknownModel";
      readonly input: string;
      readonly nearMisses: readonly ModelCandidate[];
      readonly provider?: ProviderId;
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
  /** A catalog couldn't be read and the other one doesn't list the input. */
  | {
      readonly _tag: "CatalogUnavailable";
      readonly model: string;
      readonly unavailable: readonly { readonly provider: ProviderId; readonly reason: string }[];
    }
  /** Codex lists the model without `visibility: "list"`. */
  | { readonly _tag: "HiddenCodexModel"; readonly model: string };

const MAX_EDIT_DISTANCE = 2;
// Enough choices for an agent to act on; a short prefix could otherwise match every model.
const MAX_NEAR_MISSES = 5;
const MODELS_HINT = "Run foreman models to see the available models.";
const NEAR_MISS_HINT = "Run foreman models to see every model.";
const INSTALL_HINTS: Record<ProviderId, string> = {
  codex: "Install Codex or set CODEX_BIN",
  agy: "Install agy or set AGY_BIN",
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

/**
 * The catalog models within edit distance 2 of `input`, or whose id starts with it, closest
 * first and at most five. Ties keep catalog order.
 * @throws Never; pure.
 */
export function nearMisses(
  input: string,
  catalog: readonly ModelCandidate[],
): readonly ModelCandidate[] {
  const scored = catalog
    .map((candidate) => ({ candidate, distance: editDistance(input, candidate.model) }))
    .filter(
      ({ candidate, distance }) =>
        candidate.model !== input &&
        (distance <= MAX_EDIT_DISTANCE || candidate.model.startsWith(input)),
    );
  // Array.prototype.sort is stable, so equal distances keep catalog order.
  scored.sort((left, right) => left.distance - right.distance);
  return scored.slice(0, MAX_NEAR_MISSES).map(({ candidate }) => candidate);
}

/** The unknown-model sentence: what wasn't found, the closest model if any, and where to look. */
function unknownModelDetail(failure: Extract<RoutingFailure, { _tag: "UnknownModel" }>): string {
  const subject = `Unknown model ${JSON.stringify(failure.input)}`;
  const [closest] = failure.nearMisses;
  if (closest !== undefined) {
    const reason =
      failure.provider === undefined
        ? "no provider lists it"
        : `${failure.provider} doesn't list it`;
    return `${subject}: ${reason}. Did you mean ${closest.model} (${closest.provider})? ${NEAR_MISS_HINT}`;
  }
  const reason =
    failure.provider === undefined
      ? "neither codex nor agy lists it"
      : `${failure.provider} doesn't list it`;
  return `${subject}: ${reason}. ${MODELS_HINT}`;
}

/** The catalog-unavailable sentence, naming each provider that failed and how to fix it. */
function catalogUnavailableDetail(
  failure: Extract<RoutingFailure, { _tag: "CatalogUnavailable" }>,
): string {
  const reasons = failure.unavailable
    .map(({ provider, reason }) => `${provider} is unavailable (${reason})`)
    .join(" and ");
  const hints = failure.unavailable.map(({ provider }) => INSTALL_HINTS[provider]).join(" and ");
  return `Can't check model ${JSON.stringify(failure.model)}: ${reasons}. ${hints}, then run foreman doctor.`;
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
