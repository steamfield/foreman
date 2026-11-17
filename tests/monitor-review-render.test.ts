import { stripVTControlCharacters as plain } from "node:util";
import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { expect, it } from "vitest";
import { initialState, view } from "../src/core/monitor/model";
import type { InspectViewModel } from "../src/tui/inspect-view";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, now } from "./helpers/monitor";

function finishedReview(state: "idle" | "interrupted" = "idle"): InspectViewModel {
  return {
    ...view(
      initialState({ group: "/repo", defaults, version: "test", now, columns: 140, rows: 40 }),
    ),
    detail: {
      name: "finished",
      state,
      tone: "interrupted",
      stale: false,
      status: "ready",
      message: [],
      header: [],
      warnings: [],
      panes: [],
      focus: "task",
    },
    review: {
      summary: "finished",
      reviewed: false,
      handoff: null,
      decided: [],
      files: [],
      filesNote: "",
    },
  };
}
it("shows the diff footer while a full-screen diff covers review", () => {
  const value: InspectViewModel = {
    ...finishedReview(),
    diff: {
      title: "src/cli.ts",
      position: "1 of 1 · hunk 1 of 1",
      status: "ready",
      message: null,
      lines: [],
      offset: 0,
      truncated: false,
    },
  };
  const output = plain(
    renderToString(createElement(Screen, { model: value, colors: theme(0) }), { columns: 140 }),
  );
  expect(output.split("\n").at(-1)).toContain("Esc back");
  expect(output.split("\n").at(-1)).not.toContain("mark reviewed");
});
it("uses the interrupted state badge in review", () => {
  const output = plain(
    renderToString(
      createElement(Screen, { model: finishedReview("interrupted"), colors: theme(0) }),
      { columns: 140 },
    ),
  );
  expect(output).toContain("■ interrupted");
  expect(output).not.toContain("✓ interrupted");
});

it("uses the task pane heading and scroll offsets while keeping the selected review file visible", () => {
  const columns = 100;
  const value: InspectViewModel = {
    ...view(initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 30 })),
    message: [],
    detail: {
      name: "review",
      state: "idle",
      tone: "done",
      stale: false,
      status: "ready",
      message: [],
      header: [["worktree", "/repo/work"]],
      warnings: [],
      focus: "handoff",
      panes: [
        {
          id: "task",
          title: "Task",
          value: "",
          height: 3,
          offset: 0,
          focused: false,
          lines: [{ text: "# Rename the flag", tone: "fg" }],
        },
        {
          id: "handoff",
          title: "Hand-off",
          value: "",
          height: 4,
          offset: 8,
          focused: true,
          lines: [],
        },
        {
          id: "questions",
          title: "Questions",
          value: "",
          height: 4,
          offset: 3,
          focused: false,
          lines: [],
        },
      ],
    },
    review: {
      summary: "finished",
      reviewed: false,
      handoff: {
        title: "turn 1",
        lines: Array.from({ length: 10 }, (_, index) => `handoff line ${index}`),
      },
      decided: [
        { question: "hidden decision", asked: "q1 deferred", outcome: "old" },
        { question: "visible decision", asked: "q2 deferred", outcome: "latest" },
      ],
      files: Array.from({ length: 20 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: "M",
        added: "+1",
        removed: "−0",
        outside: false,
        selected: index === 19,
      })),
      filesNote: "checks passed",
    },
  };
  const output = plain(
    renderToString(createElement(Screen, { model: value, colors: theme(0) }), { columns }),
  );
  for (const text of ["Rename the flag", "handoff line 9", "visible decision", "src/file-19.ts"])
    expect(output).toContain(text);
  expect(output).not.toContain("hidden decision");
});

it.each([
  [140, 40],
  [100, 30],
])("draws all four review sections at %ix%i", (columns, rows) => {
  const value: InspectViewModel = {
    ...view(initialState({ group: "/repo", defaults, version: "test", now, columns, rows })),
    screen: "list",
    message: [],
    detail: {
      name: "rename-flags",
      state: "idle",
      tone: "done",
      status: "ready",
      stale: false,
      message: [],
      header: [["task", "Rename --from to --base"]],
      warnings: [],
      panes: [],
      focus: "task",
    },
    review: {
      summary: "1 turn · 3 files · not reviewed",
      reviewed: false,
      handoff: { title: "turn 1 · 11:58", lines: ["Renamed the flag.", "Checks pass."] },
      decided: [
        {
          question: "Keep --from working?",
          asked: "q1 deferred after 15m",
          outcome: "Keep a hidden alias.",
        },
      ],
      files: [
        {
          path: "src/cli.ts",
          status: "M",
          added: "+14",
          removed: "−6",
          outside: false,
          selected: true,
        },
      ],
      filesNote: "all in scope · checks ✓",
      diff: {
        title: "src/cli.ts",
        position: "1 of 1 · hunk 1 of 1",
        status: "ready",
        message: null,
        lines: [{ text: "+base: Options.text", kind: "add", oldLine: null, newLine: 42 }],
        offset: 0,
        truncated: false,
      },
    },
  };
  const output = plain(
    renderToString(createElement(Screen, { model: value, colors: theme(0) }), { columns }),
  );
  for (const text of [
    "✓ idle",
    "rename-flags",
    "Rename --from to --base",
    "not reviewed",
    "Hand-off",
    "Renamed the flag.",
    "Decided without you · 1",
    "Keep --from working?",
    "Keep a hidden alias.",
    "Files · 1",
    "all in scope",
    "src/cli.ts",
    "+base: Options.text",
    "n/p hunk",
  ])
    expect(output).toContain(text);
  expect(output.split("\n")[1]).toContain("not reviewed");
  expect(output.split("\n")).toHaveLength(rows);
  for (const line of output.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
  if (columns === 140)
    expect(output).toContain(
      "Tab pane  jk scroll  n/p hunk  D open in $PAGER  r mark reviewed  F follow up  x archive  Esc list",
    );
  const overlay = plain(
    renderToString(
      createElement(Screen, {
        model: { ...value, diff: value.review?.diff ?? null },
        colors: theme(0),
      }),
      { columns },
    ),
  );
  expect(overlay).not.toContain("Hand-off");
  expect(overlay).toContain("+base: Options.text");
});
