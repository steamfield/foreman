import { describe, expect, it } from "vitest";
import { renderOverview } from "../src/core/monitor/status-all";
import { now, overview, run } from "./helpers/monitor";

describe("status --all", () => {
  it.each([
    ["monitor", "interrupted: from foreman monitor"],
    ["orchestrator", "interrupted: by the orchestrator"],
    ["budget", "interrupted: turn budget expired; foreman result shows the hand-off"],
    ["repo-hooks", "interrupted: repo hooks did not run"],
  ] as const)("says who interrupted a run (%s)", (by, flag) => {
    const text = renderOverview(
      overview([run("halted", { state: "interrupted", interruptedBy: by })]),
      "/repo",
      "foreman",
      now,
    );
    expect(text.split("\n")[3]).toContain(`  ${flag}`);
  });

  it("adds no interruption flag to a run nobody interrupted", () => {
    const text = renderOverview(overview([run("busy")]), "/repo", "foreman", now);
    expect(text).not.toContain("interrupted:");
  });
});
