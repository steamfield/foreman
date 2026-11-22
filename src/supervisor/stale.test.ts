import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "../providers/contract";
import { isStaleMessage } from "./stale";

// Provider-neutral events; tests/providers/codex-events.test.ts covers how Codex decodes them.
// A turn completion whose items no longer decode, so only the minimal turn shape did.
const minimalCompletion: readonly ProviderEvent[] = [
  { _tag: "DecodeIssue", turn: "turn-1", method: "turn/completed", issue: "minimal" },
  { _tag: "TurnCompleted", turn: "turn-1", status: "completed", failure: null, handoff: null },
];
const commandCompletion: readonly ProviderEvent[] = [
  {
    _tag: "ItemCompleted",
    turn: "turn-1",
    item: {
      kind: "command",
      id: "cmd",
      command: "true",
      status: "completed",
      exitCode: 0,
      outputTail: "",
    },
  },
];

describe("stale-turn filter", () => {
  // null means the wire named no turn, so the event applies to the active one.
  it("never drops an event that names no turn", () => {
    const unnamed = [
      { _tag: "HookStarted", turn: null, project: true },
      { _tag: "Activity", turn: null },
      { _tag: "ItemStarted", turn: null, id: "i", kind: "command", type: "execute", command: null },
    ] as const;
    for (const active of [null, "turn-1"]) expect(isStaleMessage(unnamed, active)).toBe(false);
  });

  it("keeps a minimally decoded turn completion while no turn is active", () => {
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
