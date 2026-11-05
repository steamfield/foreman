import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hookCommand, REPO, wiredCommands } from "../helpers/hooks";

describe("hook wiring", () => {
  it("wires each script exactly once and points to existing files", () => {
    const commands = wiredCommands();
    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) {
      const path = /"\$\{CLAUDE_PROJECT_DIR\}(\/[^"]+)"/.exec(command)?.[1];
      expect(path, command).toBeDefined();
      expect(existsSync(`${REPO}${path}`), command).toBe(true);
    }
  });
  it("delegates through the sole shell guard instead of wiring the TypeScript guard twice", () => {
    expect(
      wiredCommands().filter((command) =>
        /\/(block-destructive\.sh|guard-commands\.ts)/.test(command),
      ),
    ).toEqual([expect.stringContaining("/block-destructive.sh")]);
  });
  it.each([
    ["PreToolUse", "block-destructive", "Bash"],
    ["PreToolUse", "guard-generated", "Write"],
    ["PreToolUse", "guard-generated", "Edit"],
    ["PostToolUse", "typecheck-on-write", "Write"],
    ["PostToolUse", "typecheck-on-write", "Edit"],
  ])("wires %s %s for %s", (event, name, tool) => {
    expect(() => hookCommand(event, name, tool)).not.toThrow();
  });
});
