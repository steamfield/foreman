import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { theme, tokens } from "../src/tui/theme";

const luminance = (hex: string) => {
  const values = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722;
};
describe("monitor palette", () => {
  it("copies the site tokens and keeps readable text at 4.5:1 on both surfaces", async () => {
    const css = await readFile("site/src/styles/global.css", "utf8");
    for (const [name, value] of Object.entries(tokens))
      expect(css).toMatch(new RegExp(`--color-${name}:\\s*${value}\\s*;`, "i"));
    for (const background of [tokens.console, tokens["console-2"]]) {
      for (const name of [
        "console-muted",
        "state-running",
        "state-done",
        "state-failed",
        "state-interrupted",
        "signal",
      ] as const)
        expect(
          (luminance(tokens[name]) + 0.05) / (luminance(background) + 0.05),
          name,
        ).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("uses truecolor, 256, 16 and no-color capability rules without dim", () => {
    const color = theme(3);
    expect(color.paint("attention", "signal")).toContain("38;2;255;91;20");
    expect(theme(2).paint("running", "running")).toContain("38;5;");
    expect(theme(1).paint("running", "running")).toBe("\u001b[34mrunning\u001b[39m");
    expect(theme(1).paint("question", "signal")).toBe(
      "\u001b[91m\u001b[1mquestion\u001b[22m\u001b[39m",
    );
    expect(theme(1).background).toBeUndefined();
    expect(theme(1).paint("age", "muted")).toBe("age");
    expect(theme(3, true).paint("waiting", "signal")).toBe("waiting");
    expect(theme(0).select("selected")).toBe("\u001b[7mselected\u001b[27m");
    expect(color.paint("text", "muted")).not.toContain("\u001b[2m");
  });
});
