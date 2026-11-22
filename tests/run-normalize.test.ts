import { describe, expect, it } from "vitest";
import { contractTitle } from "../src/core/runs/normalize";

describe("contract titles", () => {
  it.each([
    ["# Add the thing", "Add the thing"],
    ["\n  Plain contract line  \nsecond line", "Plain contract line"],
    ["Introduction\n\n## Actual heading ##\nbody", "Actual heading"],
    [`# ${"x".repeat(130)}`, "x".repeat(120)],
    ["\n \r\n", null],
  ])("reads a display title from %j", (contract, expected) => {
    expect(contractTitle(contract ?? "")).toBe(expected);
  });
});
