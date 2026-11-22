/**
 * Model routing: which provider runs a start, from the model it names. docs/rfcs/0002-providers.md
 * "Model routing and its errors" is the rule set and the error wording.
 */
import { Effect } from "effect";
import type { AgyUnavailable, Usage } from "../errors";
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
  /** Model ids Codex lists. */
  readonly codex: Effect.Effect<readonly string[]>;
  readonly agy: Effect.Effect<AgyCatalog, AgyUnavailable>;
}

/**
 * Resolves a start's model to a provider.
 * @throws {Usage} When the model is unknown or ambiguous, or the effort or tier don't apply.
 * @throws {AgyUnavailable} When agy's catalog is needed and can't be read.
 */
export const resolveModel = (
  _request: ModelRequest,
  _catalogs: ModelCatalogs,
): Effect.Effect<RoutedModel, Usage | AgyUnavailable> => Effect.die(new Error("not implemented"));
