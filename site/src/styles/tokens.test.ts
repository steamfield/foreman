import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles/global.css", "utf8");
const design = readFileSync("DESIGN.md", "utf8");
const theme = css.match(/@theme\s*\{([^}]+)\}/)?.[1] ?? "";
const tokens = new Map(
  [...theme.matchAll(/--color-([\w-]+):\s*(#[\da-f]{6});/gi)].map(
    (match) => [match[1], match[2]] as const,
  ),
);

function luminance(token: string) {
  const hex = tokens.get(token);
  if (!hex) throw new Error(`Missing @theme color: ${token}`);
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const body = ["ink", "ink-2"].flatMap((text) =>
  ["page", "band", "card"].map((surface) => [text, surface] as const),
);
const meta: (readonly [string, string])[] = [
  ...["ink-3", "signal-text"].flatMap((text) =>
    ["page", "band"].map((surface) => [text, surface] as const),
  ),
  ["console-muted", "console"],
  ["console-muted", "console-2"],
  ...["running", "done", "failed", "interrupted"].flatMap((state) => [
    [`state-${state}`, "console"] as const,
    [`state-${state}-ink`, "page"] as const,
  ]),
  ["signal", "console"],
  ["signal-text", "page"],
  ["ink-3", "page"],
  ["signal-ink", "signal"],
];

describe("DESIGN.md token contrast contract", () => {
  it("documents every @theme color token by name", () => {
    expect(tokens.size).toBeGreaterThan(0);
    expect(tokens.size).toBe([...theme.matchAll(/--color-/g)].length);
    for (const name of tokens.keys()) expect(design).toContain(`\`${name}\``);
  });

  it.each(body)("body %s on %s reaches 7:1", (text, surface) => {
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(7);
  });

  it.each(meta)("meta %s on %s reaches 4.5:1", (text, surface) => {
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
  });
});
