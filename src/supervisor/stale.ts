/**
 * The stale-turn filter: whether a provider message belongs to a turn other than the run's
 * active one and should change nothing but the raw log and warnings.
 */
import type { ProviderEvent, TurnId } from "../providers/contract";

/** Diagnostics the supervisor records before filtering, whatever turn they name. */
const DIAGNOSTIC_TAGS: ReadonlySet<ProviderEvent["_tag"]> = new Set([
  "DecodeIssue",
  "Unrecognized",
]);

/**
 * Reports whether one event names a turn other than the active one. Turn events are only
 * stale once a turn is active; other events also when none is.
 */
export function isStaleEvent(event: ProviderEvent, activeTurnId: TurnId | null): boolean {
  if (event.turn === null || DIAGNOSTIC_TAGS.has(event._tag)) return false;
  if (event._tag === "TurnStarted" || event._tag === "TurnCompleted")
    return activeTurnId !== null && event.turn !== activeTurnId;
  return event.turn !== activeTurnId;
}

/** Reports whether a message's events belong to a stale turn, so the message is dropped. */
export function isStaleMessage(
  events: readonly ProviderEvent[],
  activeTurnId: TurnId | null,
): boolean {
  return events.some((event) => isStaleEvent(event, activeTurnId));
}
