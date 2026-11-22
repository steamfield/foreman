import { describe, expect, it } from "vitest";
import { agyEnvironment } from "../../src/providers/agy/environment";
import {
  decidePermission,
  type PermissionDecision,
  pickOption,
  refusalMessage,
} from "../../src/providers/agy/permissions";
import type { TurnKind } from "../../src/schemas/daemon";
import type { Access } from "../../src/schemas/provider";

const ASK = "mcp_foreman_ask_orchestrator";
const ACCESSES: Access[] = ["write", "read-only"];
const TURN_KINDS: TurnKind[] = ["start", "followup", "handoff"];

const decide = (kind: string, access: Access, turnKind: TurnKind, name: string | null = null) =>
  decidePermission({ kind, name, access, turnKind, known: true });

describe("permission policy", () => {
  const cases = ACCESSES.flatMap((access) =>
    TURN_KINDS.map((turnKind) => {
      const handoff = turnKind === "handoff";
      const editAllowed = access === "write" && !handoff;
      const row: [Access, TurnKind, PermissionDecision, PermissionDecision, PermissionDecision] = [
        access,
        turnKind,
        handoff ? "rejected" : "approved",
        editAllowed ? "approved" : "rejected",
        "approved",
      ];
      return row;
    }),
  );

  it.each(cases)(
    "%s run, %s turn: question, edits, shell and other kinds",
    (access, turnKind, question, edits, other) => {
      expect(decide("other", access, turnKind, ASK)).toBe(question);
      for (const kind of ["edit", "delete", "move"]) {
        expect(decide(kind, access, turnKind)).toBe(edits);
      }
      expect(decide("execute", access, turnKind, "run_command")).toBe("approved");
      for (const kind of ["read", "fetch", "search", "think", "other"]) {
        expect(decide(kind, access, turnKind)).toBe(other);
      }
    },
  );

  it("rejects every request from a session foreman did not open", () => {
    for (const access of ACCESSES)
      for (const turnKind of TURN_KINDS)
        expect(decidePermission({ kind: "read", name: null, access, turnKind, known: false })).toBe(
          "rejected",
        );
  });

  it("treats another MCP tool as an ordinary other-kind call", () => {
    expect(decide("other", "read-only", "start", "mcp_other_tool")).toBe("approved");
    expect(decide("other", "read-only", "handoff", "mcp_other_tool")).toBe("approved");
  });
});

describe("option picking", () => {
  const allow = { optionId: "allow", kind: "allow_once" };
  const deny = { optionId: "deny", kind: "reject_once" };
  const always = { optionId: "always", kind: "allow_always" };
  const neverAgain = { optionId: "never", kind: "reject_always" };

  it("picks by kind, not by option id", () => {
    const options = [
      { optionId: "deny", kind: "allow_once" },
      { optionId: "allow", kind: "reject_once" },
    ];
    expect(pickOption(options, "approved")).toBe("deny");
    expect(pickOption(options, "rejected")).toBe("allow");
  });

  it("never picks allow_always, even when it is the only allow", () => {
    expect(pickOption([always, deny], "approved")).toBe("deny");
  });

  it("answers an approval with the rejection when no allow_once exists", () => {
    expect(pickOption([neverAgain], "approved")).toBe("never");
  });

  it("falls back to any reject_* when reject_once is missing", () => {
    expect(pickOption([allow, neverAgain], "rejected")).toBe("never");
  });

  it("returns null when nothing fits", () => {
    expect(pickOption([always], "approved")).toBeNull();
    expect(pickOption([allow], "rejected")).toBeNull();
    expect(pickOption([], "approved")).toBeNull();
  });

  it("takes the first option of the wanted kind", () => {
    expect(pickOption([allow, { optionId: "again", kind: "allow_once" }, deny], "approved")).toBe(
      "allow",
    );
  });
});

describe("refusal message", () => {
  it("names a read-only run", () => {
    expect(refusalMessage("Edit src/a.ts", "edit", "start")).toBe(
      "foreman refused Edit src/a.ts (edit) in a read-only run; agy ends a turn when a permission is refused. Follow up with narrower instructions or start a write run.",
    );
  });

  it("names the hand-off turn instead", () => {
    expect(refusalMessage("Edit src/a.ts", "edit", "handoff")).toContain(
      "in the budget hand-off turn;",
    );
  });
});

describe("agy environment", () => {
  const credentials = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GEMINI_BASE_URL",
    "GOOGLE_GENAI_USE_ENTERPRISE",
    "AGY_ADC_AUTH",
    "ANTIGRAVITY_PROJECT_ID",
  ];
  const ssh = { alive: true, launchdSocket: undefined };

  it.each(credentials)("drops %s", (name) => {
    expect(agyEnvironment({ [name]: "secret", KEEP: "1" }, ssh)).not.toHaveProperty(name);
  });

  it("keeps unrelated variables and adds both delegate markers", () => {
    expect(agyEnvironment({ HOME: "/home/a", GEMINI_API_KEY: "x" }, ssh)).toEqual({
      HOME: "/home/a",
      AGY_DELEGATE: "1",
      STACKS_DELEGATE: "1",
    });
  });

  it("drops foreman and Claude variables and does not mark the run as Codex", () => {
    const env = agyEnvironment(
      { FOREMAN_HOME: "/h", CLAUDE_CODE_X: "1", LOG_LEVEL: "debug", CODEX_DELEGATE: "1" },
      ssh,
    );
    expect(env).toEqual({ CODEX_DELEGATE: "1", AGY_DELEGATE: "1", STACKS_DELEGATE: "1" });
  });
});
