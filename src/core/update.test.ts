import { describe, expect, it } from "vitest";
import { installMethod, isNewer } from "./update";

describe("isNewer", () => {
  it.each([
    ["0.1.3", "0.1.2", true],
    ["0.2.0", "0.1.9", true],
    ["0.1.10", "0.1.9", true],
    ["0.1.2", "0.1.2", false],
    ["0.1.1", "0.1.2", false],
    ["0.1.2", "dev", true],
    ["garbage", "0.1.2", false],
  ])("%s over %s is %s", (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });
});

describe("installMethod", () => {
  it.each([
    ["/opt/homebrew/lib/node_modules/@steamfield/foreman/npm/foreman.cjs", "npm"],
    ["/usr/lib/node_modules/@steamfield/foreman-linux-x64/bin/foreman", "npm"],
    ["/Users/me/.bun/install/global/node_modules/@steamfield/foreman/npm/foreman.cjs", "bun"],
    ["/Users/me/.npm/_npx/1a2b/node_modules/@steamfield/foreman/npm/foreman.cjs", "npx"],
    ["/Users/me/Library/pnpm/global/5/node_modules/@steamfield/foreman/npm/foreman.cjs", "pnpm"],
    ["/work/app/node_modules/@steamfield/foreman/npm/foreman.cjs", "project"],
    ["/Users/me/.local/bin/foreman", "source"],
    [undefined, "source"],
  ])("%s is %s", (path, expected) => {
    expect(installMethod(path)).toBe(expected);
  });
});
