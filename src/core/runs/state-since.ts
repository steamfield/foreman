import type { RunEvent, RunRecord } from "../../schemas/daemon";

export function stateSince(record: RunRecord, events: readonly RunEvent[]) {
  return events.findLast(({ event }) => event._tag === "StateChanged")?.at ?? record.createdAt;
}
