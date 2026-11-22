/**
 * The errors model routing raises: one ModelUnresolved per row of docs/rfcs/0002-providers.md
 * "Model routing and its errors", with near-miss suggestions across both catalogs. Pure.
 */
import type { ModelUnresolved } from "../errors";
import type { ModelCandidate } from "../schemas/models";
import type { ProviderId } from "../schemas/provider";

/** Why routing failed, with the values its message names. */
export type RoutingFailure =
  /** No catalog lists the input; `nearMisses` may be empty. */
  | {
      readonly _tag: "UnknownModel";
      readonly input: string;
      readonly nearMisses: readonly ModelCandidate[];
    }
  /** Both providers list the model. */
  | { readonly _tag: "Ambiguous"; readonly model: string }
  /** The model's effort suffix and --effort disagree. */
  | {
      readonly _tag: "EffortConflict";
      readonly model: string;
      readonly family: string;
      readonly modelEffort: string;
      readonly effort: string;
    }
  /** --effort isn't one the model accepts. */
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

/**
 * The catalog models within edit distance 2 of `input`, or whose id starts with it, closest
 * first.
 */
export function nearMisses(
  input: string,
  catalog: readonly ModelCandidate[],
): readonly ModelCandidate[] {
  throw new Error(`not implemented: nearMisses(${input}, ${catalog.length} models)`);
}

/** The ModelUnresolved error for a failure, worded as the RFC table says. */
export function routingError(failure: RoutingFailure): ModelUnresolved {
  throw new Error(`not implemented: routingError(${failure._tag})`);
}
