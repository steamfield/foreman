import { stripVTControlCharacters as plain } from "node:util";
import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { expect, it } from "vitest";
import { initialState, view } from "../src/core/monitor/model";
import type { ViewModel } from "../src/core/monitor/model-types";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, now } from "./helpers/monitor";

function finishedReview(state: "idle" | "interrupted" = "idle"): ViewModel {
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
      focus: "handoff",
      filesMessage: "No changes.",
      lateAnswerHint: "a answer late (starts a follow-up turn)",
      summary: "finished",
      reviewed: false,
      handoff: null,
      decided: [],
      files: [],
      filesNote: "",
    },
  };
}

function borderColors(output: string, glyph: string) {
  const color = new RegExp(`${String.fromCharCode(27)}\\[38;2;(\\d+;\\d+;\\d+)m`, "g");
  let foreground: string | undefined;
  return output
    .split(glyph)
    .slice(0, -1)
    .map((part) => {
      foreground = [...part.matchAll(color)].at(-1)?.[1] ?? foreground;
      return foreground;
    });
}
it("keeps review sections and actions visible while its diff is open", () => {
  const value: ViewModel = {
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
  expect(output).toContain("Hand-off");
  expect(output).toContain("src/cli.ts");
  expect(output.split("\n").at(-1)).toContain("mark reviewed");
  expect(output.split("\n").at(-1)).toContain("Esc back");
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
  const value: ViewModel = {
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
      focus: "handoff",
      filesMessage: null,
      lateAnswerHint: "a answer late (starts a follow-up turn)",
      summary: "finished",
      reviewed: false,
      handoff: {
        title: "Hand-off · turn 1",
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
  const value: ViewModel = {
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
      focus: "diff",
      filesMessage: null,
      lateAnswerHint: "a answer late (starts a follow-up turn)",
      summary: "1 turn · 3 files · not reviewed",
      reviewed: false,
      handoff: { title: "Hand-off · turn 1 · 11:58", lines: ["Renamed the flag.", "Checks pass."] },
      decided: [
        {
          question: "Keep --from working?",
          asked: "q1 deferred after 15m",
          outcome: "→ the delegate went with: Keep a hidden alias.",
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
    },
    diff: {
      title: "src/cli.ts",
      position: "1 of 1 · hunk 1 of 1",
      status: "ready",
      message: null,
      lines: [{ text: "+base: Options.text", kind: "add", oldLine: null, newLine: 42 }],
      offset: 0,
      truncated: false,
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
  expect(output).not.toContain("Hand-off · Hand-off");
  expect(output).not.toContain("→ →");
  expect(output.split("\n")[1]).toContain("not reviewed");
  expect(output.split("\n")).toHaveLength(rows);
  expect(output).toMatchSnapshot();
  for (const line of output.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
  if (columns === 140)
    expect(output).toContain(
      "Tab pane  jk scroll  n/p hunk  D open in $PAGER  r mark reviewed  F follow up  x archive  Esc back",
    );
  const overlay = plain(
    renderToString(
      createElement(Screen, {
        model: { ...value, review: null },
        colors: theme(0),
      }),
      { columns },
    ),
  );
  expect(overlay).not.toContain("Hand-off");
  expect(overlay).toContain("+base: Options.text");
});

it.each(["handoff", "decided", "files", "diff"] as const)(
  "uses review focus for the %s border independently of detail focus",
  (focus) => {
    const base = finishedReview();
    if (!base.review) throw new Error("Expected review");
    const colors = theme(3);
    const output = renderToString(
      createElement(Screen, {
        model: {
          ...base,
          review: { ...base.review, focus },
          diff: {
            title: "Diff",
            position: "hunk 1 of 1",
            status: "ready",
            message: null,
            lines: [{ text: "+new option", kind: "add", oldLine: null, newLine: 1 }],
            offset: 0,
            truncated: false,
          },
        },
        colors,
      }),
      { columns: 140 },
    );
    const expected = ["handoff", "decided", "files", "diff"].map((pane) =>
      pane === focus ? "228;232;224" : "45;50;43",
    );
    expect(borderColors(output, "╭─ ")).toEqual(expected);
    const rows = output
      .split("\n")
      .filter((line) => plain(line).includes("│"))
      .slice(0, 3);
    expect(rows.flatMap((line) => borderColors(line, "│"))).toEqual(
      expected.flatMap((tone) => [tone, tone]),
    );
  },
);

it.each(["loading changes…", "Changes read: permission denied.", "No changes."])(
  "shows the model's Files message: %s",
  (filesMessage) => {
    const base = finishedReview();
    if (!base.review) throw new Error("Expected review");
    const output = plain(
      renderToString(
        createElement(Screen, {
          model: { ...base, review: { ...base.review, filesMessage } },
          colors: theme(0),
        }),
        { columns: 140 },
      ),
    );
    expect(output).toContain(filesMessage);
  },
);

it("keeps the Files message visible with its scope note in stacked review", () => {
  const base = finishedReview();
  if (!base.review) throw new Error("Expected review");
  const output = plain(
    renderToString(
      createElement(Screen, {
        model: {
          ...base,
          columns: 100,
          rows: 30,
          review: {
            ...base.review,
            filesMessage: "Changes read: permission denied.",
            filesNote: "all in scope",
          },
        },
        colors: theme(0),
      }),
      { columns: 100 },
    ),
  );
  expect(output).toContain("Changes read: permission denied.");
  expect(output).toContain("all in scope");
  expect(output.split("\n")).toHaveLength(30);
});

it("uses the model's late-answer hint and decision outcome", () => {
  const base = finishedReview();
  if (!base.review) throw new Error("Expected review");
  const output = plain(
    renderToString(
      createElement(Screen, {
        model: {
          ...base,
          review: {
            ...base.review,
            lateAnswerHint: "a answer late · follow-up turn",
            decided: [
              {
                asked: "11:58",
                question: "Keep the alias?",
                outcome: "→ deferred, no answer recorded",
              },
            ],
          },
        },
        colors: theme(0),
      }),
      { columns: 140 },
    ),
  );
  expect(output).toContain("a answer late · follow-up turn");
  expect(output).toContain("→ deferred, no answer recorded");
  expect(output).not.toContain("→ →");
});
