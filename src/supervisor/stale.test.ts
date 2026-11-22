import { describe, expect, it } from "vitest";
import { decodeNotification } from "../providers/codex/events";
import { isStaleMessage } from "./stale";

const noItems = { turn: null, items: [] };
const events = (method: string, params: unknown) =>
  decodeNotification({ method, params }, noItems).inbound.events;

// The turn's `items` no longer decode, so only the minimal turn shape does.
const minimalCompletion = events("turn/completed", {
  threadId: "thread",
  turn: { id: "turn-1", status: "completed", items: "changed upstream" },
});
const commandCompletion = events("item/completed", {
  threadId: "thread",
  turnId: "turn-1",
  item: {
    type: "commandExecution",
    id: "cmd",
    command: "true",
    status: "completed",
    aggregatedOutput: "",
    exitCode: 0,
  },
});

describe("stale-turn filter", () => {
  it("keeps a minimally decoded turn completion while no turn is active", () => {
    expect(minimalCompletion.map((event) => event._tag)).toEqual(["DecodeIssue", "TurnCompleted"]);
    expect(isStaleMessage(minimalCompletion, null)).toBe(false);
  });

  it("drops a minimally decoded completion of another turn once one is active", () => {
    expect(isStaleMessage(minimalCompletion, "turn-2")).toBe(true);
    expect(isStaleMessage(minimalCompletion, "turn-1")).toBe(false);
  });

  it("drops item events while no turn is active or for another turn", () => {
    expect(isStaleMessage(commandCompletion, null)).toBe(true);
    expect(isStaleMessage(commandCompletion, "turn-2")).toBe(true);
    expect(isStaleMessage(commandCompletion, "turn-1")).toBe(false);
  });
});
