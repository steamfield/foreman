import { describe, expect, it } from "vitest";
import doctor from "../../fixtures/cli/doctor.json";
import result from "../../fixtures/cli/result.json";
import status from "../../fixtures/cli/status-release.json";
import { commandOutputParts, loadCommands } from "./commands";

const fixtures = import.meta.glob<{
  command: string;
  output: string;
  exitCode: number;
}>("../../fixtures/cli/*.json", { eager: true, import: "default" });
const order = [
  "start-wait",
  "wait-all",
  "answer",
  "status-release",
  "result",
  "archive",
  "doctor",
];

describe("recorded command reference", () => {
  it("marks the recorded successful idle state and failed command exit", () => {
    const parts = commandOutputParts(result.output);
    expect(parts).toContainEqual({ text: "idle", tone: "done" });
    expect(parts).toContainEqual({ text: "exit=1", tone: "failed" });
    expect(parts.map((part) => part.text).join("")).toBe(result.output);
  });

  it("loads only available recordings in reference order, preserving command and output exactly", () => {
    const commands = loadCommands();
    expect(commands.map((command) => command.name)).toEqual(
      order.filter((name) => `../../fixtures/cli/${name}.json` in fixtures),
    );
    for (const command of commands) {
      const fixture = fixtures[`../../fixtures/cli/${command.name}.json`];
      expect(command.command).toBe(fixture?.command);
      expect(command.output).toBe(fixture?.output);
      expect(command.label).toBeTruthy();
      expect(command.caption).toBeTruthy();
    }
  });

  it("supports missing recordings without changing the reference order", () => {
    const commands = loadCommands({
      "../../fixtures/cli/doctor.json": doctor,
      "../../fixtures/cli/status-release.json": status,
    });
    expect(commands.map((command) => command.name)).toEqual([
      "status-release",
      "doctor",
    ]);
    expect(commands.map((command) => command.label)).toEqual([
      "status",
      "doctor",
    ]);
    expect(loadCommands({})).toEqual([]);
  });

  it("preserves every recorded character when annotating states and exits", () => {
    for (const { output } of loadCommands()) {
      const parts = commandOutputParts(output);
      expect(parts.map((part) => part.text).join("")).toBe(output);
      for (const part of parts.filter((part) => part.tone)) {
        expect(part.text).toMatch(
          /^(starting|running|waiting|idle|failed|interrupted|lost|exit=-?\d+)$/,
        );
        if (part.text.startsWith("exit=")) {
          expect(part.tone).toBe(part.text === "exit=0" ? "done" : "failed");
        }
      }
    }
    expect(commandOutputParts(doctor.output)).toEqual([
      { text: doctor.output },
    ]);
    expect(commandOutputParts(status.output)).toEqual([
      { text: status.output },
    ]);
    expect(commandOutputParts("")).toEqual([{ text: "" }]);
  });
});
