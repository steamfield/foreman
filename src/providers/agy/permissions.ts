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

const ASK_ORCHESTRATOR_TOOL = "mcp_foreman_ask_orchestrator";
const EDIT_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

/** Decides a permission request from the tool, the run's access and the turn kind. */
export function decidePermission(request: PermissionRequest): PermissionDecision {
  if (!request.known) return "rejected";
  if (request.name === ASK_ORCHESTRATOR_TOOL)
    return request.turnKind === "handoff" ? "rejected" : "approved";
  if (EDIT_KINDS.has(request.kind))
    return request.access === "write" && request.turnKind !== "handoff" ? "approved" : "rejected";
  return "approved";
}

const firstOfKind = (options: readonly PermissionOption[], kind: string): string | null =>
  options.find((option) => option.kind === kind)?.optionId ?? null;

const firstRejection = (options: readonly PermissionOption[]): string | null =>
  options.find((option) => option.kind.startsWith("reject_"))?.optionId ?? null;

/**
 * Picks the option id that carries a decision, never an `allow_always`. An approval with no
 * `allow_once` option falls back to the rejection choice, so foreman never grants more than
 * it decided. Returns null when no option fits; the caller then answers
 * `{outcome: {outcome: "cancelled"}}`.
 */
export function pickOption(
  options: readonly PermissionOption[],
  decision: PermissionDecision,
): string | null {
  if (decision === "approved") {
    const allow = firstOfKind(options, "allow_once");
    if (allow !== null) return allow;
  }
  return firstOfKind(options, "reject_once") ?? firstRejection(options);
}

/** The run failure message after foreman refused a tool call (agy then ends the turn). */
export function refusalMessage(title: string, kind: string, turnKind: TurnKind): string {
  const where = turnKind === "handoff" ? "the budget hand-off turn" : "a read-only run";
  return `foreman refused ${title} (${kind}) in ${where}; agy ends a turn when a permission is refused. Follow up with narrower instructions or start a write run.`;
}
