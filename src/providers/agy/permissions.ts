/**
 * How foreman answers agy's permission requests: the decision for a tool call given the run's
 * access and turn kind, the option that carries it, and the run failure a refusal causes.
 * docs/rfcs/0002-providers.md "Permissions" is the table. Pure functions.
 */
import type { TurnKind } from "../../schemas/daemon";
import type { Access } from "../../schemas/provider";

export type PermissionDecision = "approved" | "rejected";

/** One `session/request_permission`, reduced to what the policy reads. */
export interface PermissionRequest {
  /** The tool call's ACP kind: execute, edit, delete, move, read, fetch, other, ... */
  readonly kind: string;
  /** agy's tool name (`run_command`, `mcp_foreman_ask_orchestrator`), when it sent one. */
  readonly name: string | null;
  readonly access: Access;
  readonly turnKind: TurnKind;
  /** False when the request names a session this connection didn't open. */
  readonly known: boolean;
}

/** An option agy offers on a permission request. */
export interface PermissionOption {
  readonly optionId: string;
  /** allow_once, allow_always, reject_once, reject_always. */
  readonly kind: string;
}

/** Decides a permission request. */
export function decidePermission(_request: PermissionRequest): PermissionDecision {
  throw new Error("not implemented");
}

/**
 * Picks the option id that carries a decision, never an `allow_always`. Returns null when no
 * option fits; the caller then answers `{outcome: {outcome: "cancelled"}}`.
 */
export function pickOption(
  _options: readonly PermissionOption[],
  _decision: PermissionDecision,
): string | null {
  throw new Error("not implemented");
}

/** The run failure message after foreman refused a tool call (agy then ends the turn). */
export function refusalMessage(_title: string, _kind: string, _turnKind: TurnKind): string {
  throw new Error("not implemented");
}
