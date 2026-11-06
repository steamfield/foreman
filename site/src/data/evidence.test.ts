import { describe, expect, it } from "vitest";
import {
  contractExcerpt,
  digestBlocks,
  questionPairs,
  runTimelines,
} from "./evidence";
import { loadRun, releaseRuns } from "./runs";
import { formatElapsed } from "../lib/format";

const supervisor = loadRun("fix-supervisor");

describe("contract evidence", () => {
  it("keeps the real title, first Goal paragraph and entire Scope", () => {
    const excerpt = contractExcerpt(supervisor.contract);
    expect(excerpt.title).toBe(
      "# Contract: release fixes, part B: supervisor state, persistence and recovery",
    );
    expect(excerpt.goal).toBe(
      supervisor.contract.split("## Goal\n\n")[1]?.split("\n\n")[0],
    );
    expect(excerpt.scope).toBe(
      supervisor.contract
        .split("## Scope\n\n")[1]
        ?.split("\n\n## How to work")[0],
    );
    expect(excerpt.scopeLines.join("\n")).toBe(excerpt.scope);
    expect(excerpt.goal).not.toContain("Notes on the larger ones");
    expect(excerpt.scope).toContain("- Owned by other units:");
  });

  it("fails loudly if the recorded contract loses Scope", () => {
    const withoutScope = supervisor.contract.replace(
      /## Scope\n[\s\S]*?(?=## How to work)/,
      "",
    );
    expect(() => contractExcerpt(withoutScope)).toThrow(
      "missing its Scope section",
    );
  });

  it("fails loudly if the scope loses its May change line", () => {
    expect(() =>
      contractExcerpt(supervisor.contract.replace("- May change:", "- Files:")),
    ).toThrow("May change line");
  });
});

describe("digest evidence", () => {
  it("identifies both flagged files without changing the recorded output", () => {
    const blocks = digestBlocks(supervisor.digest);
    expect(blocks.outside).toBe(
      "outside May change:\n  tests/run-store.test.ts\n  tests/supervisor-integration.test.ts\n",
    );
    expect(blocks.before + blocks.outside + blocks.after).toBe(
      supervisor.digest,
    );
    expect(blocks.startLine).toBe(24);
    expect(blocks.lineCount).toBe(3);
    expect(blocks.after).toMatch(/^new in git status since start:/);
  });

  it("leaves a digest without scope flags intact", () => {
    const digest = loadRun("fix-daemon").digest;
    expect(digest).toContain("outside May change:  (none)");
    expect(digestBlocks(digest)).toEqual({
      before: digest,
      outside: "",
      after: "",
      startLine: 0,
      lineCount: 0,
    });
  });
});

describe("question evidence", () => {
  it("pairs the two verbatim exchanges and reports their rounded response gaps", () => {
    const pairs = questionPairs(supervisor);
    expect(
      pairs.map(({ asked, resolved, elapsedMs }) => [
        asked.id,
        resolved.resolution,
        formatElapsed(elapsedMs),
      ]),
    ).toEqual([
      ["q1", "answered", "19s"],
      ["q2", "auto-answered", "15m00s"],
    ]);
    expect(pairs.flatMap(({ asked, resolved }) => [asked, resolved])).toEqual(
      supervisor.questions,
    );
    expect(pairs[0]?.hook).toBeUndefined();
    expect(pairs[1]?.hook).toEqual(
      supervisor.events.find((event) => event.kind === "hook-blocked"),
    );
  });

  it("refuses to silently omit a missing answer", () => {
    expect(() =>
      questionPairs({
        ...supervisor,
        questions: supervisor.questions.filter((q) => q._tag !== "Resolved"),
      }),
    ).toThrow("q1 has no recorded resolution");
  });
});

describe("parallel evidence", () => {
  it("uses one base and the earliest creation time even when that run is not first", () => {
    expect(new Set(releaseRuns.map((run) => run.baseCommit))).toEqual(
      new Set(["39aec16"]),
    );
    const timeline = runTimelines(releaseRuns);
    expect(
      timeline.rows.map(({ name, startMs, endMs }) => [name, startMs, endMs]),
    ).toEqual([
      ["fix-cli", 17242, 1503309],
      ["fix-daemon", 0, 1559337],
      ["fix-supervisor", 3548, 4234142],
      ["fix-worktrees", 10467, 1752062],
    ]);
    expect(timeline.extentMs).toBe(4800000);
    expect(timeline.ticks).toEqual([
      0, 600000, 1200000, 1800000, 2400000, 3000000, 3600000, 4200000, 4800000,
    ]);
    expect(timeline.rows[2]?.questions).toEqual([
      { id: "q1", atMs: 1225538 },
      { id: "q2", atMs: 2359659 },
    ]);
  });

  it("counts all recorded commands, failures, unique file paths and output tokens", () => {
    expect(
      runTimelines(releaseRuns).rows.map(
        ({ durationMs, commands, failed, files, outputTokens }) => [
          durationMs,
          commands,
          failed,
          files,
          outputTokens,
        ],
      ),
    ).toEqual([
      [1486067, 180, 27, 25, 65229],
      [1559337, 232, 43, 12, 57315],
      [4230594, 299, 34, 18, 174784],
      [1741595, 186, 23, 15, 69031],
    ]);
  });

  it("rejects runs from different base commits", () => {
    expect(() =>
      runTimelines([
        ...releaseRuns,
        { ...supervisor, baseCommit: "another-base" },
      ]),
    ).toThrow("share one base commit");
  });
});
