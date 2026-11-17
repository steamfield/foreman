import { stripVTControlCharacters as plain } from "node:util";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, expect, it } from "vitest";
import { type DiffView, initialState, reduce, view } from "../src/core/monitor/model";
import type { InspectViewModel } from "../src/tui/inspect-view";
import { MonitorApp, Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, live, now, run } from "./helpers/monitor";

afterEach(cleanup);
it.each(["review", "reviewed"])("renders the model's %s hint in the flags column", (hint) => {
  const base = view(
    reduce(
      initialState({ group: "/repo", defaults, version: "test", now, columns: 140, rows: 40 }),
      { type: "feed", value: live([run("finished", { state: "idle" })]) },
    ),
  );
  const groups = base.groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) => ({ ...row, flags: [{ text: hint, tone: "muted" as const }] })),
  }));
  const output = plain(
    renderToString(createElement(Screen, { model: { ...base, groups }, colors: theme(0) }), {
      columns: 140,
    }),
  );
  expect(
    output.split("\n").find((line) => line.includes("finished") && line.includes("idle")),
  ).toContain(hint);
});
function model(columns = 140): InspectViewModel {
  return {
    ...view(initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 40 })),
    screen: "list",
    message: [],
    animating: false,
    detail: {
      name: "retry",
      state: "running",
      tone: "running",
      stale: false,
      status: "ready",
      message: [],
      header: [["task", "Retry connections"]],
      warnings: [],
      focus: "task",
      panes: [
        {
          id: "task",
          title: "Task",
          value: "",
          lines: [{ text: "Retry connections", tone: "fg" }],
          height: 3,
          offset: 0,
          focused: true,
        },
        {
          id: "feed",
          title: "Feed",
          value: "following",
          lines: [{ text: "checks passed", tone: "done" }],
          height: 5,
          offset: 0,
          focused: false,
        },
      ],
    },
    timeline: {
      label: "Timeline",
      cells: [
        { glyph: "━", tone: "running" },
        { glyph: "■", tone: "signal" },
      ],
      subagentCells: [{ glyph: "·", tone: "muted" }],
      ticks: "11:52     12:04",
      legend: "working · waiting",
    },
    files: [
      {
        path: "src/client.ts",
        status: "M",
        added: "+42",
        removed: "−7",
        outside: true,
        selected: true,
      },
    ],
    filesFocused: true,
    feedTabs: { filter: "all", search: "", editing: false },
  };
}
const diff: DiffView = {
  title: "src/client.ts",
  position: "1 of 3 · hunk 1 of 2",
  status: "ready",
  message: null,
  offset: 1,
  truncated: true,
  lines: [
    { text: "hidden before offset", kind: "meta", oldLine: null, newLine: null },
    { text: "@@ -41,2 +41,2 @@", kind: "hunk", oldLine: null, newLine: null },
    { text: "-old", kind: "remove", oldLine: 41, newLine: null },
    { text: "+new", kind: "add", oldLine: null, newLine: 41 },
    { text: ` context ${"界".repeat(200)}`, kind: "context", oldLine: 42, newLine: 42 },
  ],
};
function frame(value: InspectViewModel, noColor = false) {
  return renderToString(createElement(Screen, { model: value, colors: theme(3, noColor) }), {
    columns: value.columns,
  });
}
it.each([140, 100, 80])(
  "draws timeline, files and feed tabs without wrapping at %i columns",
  (columns) => {
    const value = model(columns);
    const output = plain(frame(value));
    for (const text of [
      "Timeline",
      "11:52",
      "working · waiting",
      "Files",
      "src/client.ts",
      "+42",
      "−7",
      "▲ outside May change",
      "Feed",
      " all ",
      "cmds",
      "files",
      "msgs",
      "q&a",
    ])
      expect(output).toContain(text);
    expect(output.split("\n")).toHaveLength(40);
    for (const line of output.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    if (columns < 120)
      expect(output.split("\n").find((line) => line.includes("Files"))).not.toContain("Feed");
    else
      expect(output).toContain(
        "Tab pane  jk move  d diff file  D all in $PAGER  1-5 feed filter  / search feed  s steer  i interrupt  Esc list",
      );
  },
);
it("keeps existing actions and escape hints visible as the detail footer narrows", () => {
  for (const columns of [140, 100, 70]) {
    const footer =
      plain(frame(model(columns)))
        .split("\n")
        .at(-1) ?? "";
    expect(footer).toContain("Esc list");
    if (columns === 140) expect(footer).toContain("F follow up  x archive");
    else expect(footer).toContain("q quit");
    if (columns >= 100) expect(footer).toContain("s steer  i interrupt");
    expect(stringWidth(footer)).toBeLessThanOrEqual(columns);
  }
});
it("paints counts, scope warnings, selected files and the active tab", () => {
  const value = model();
  const output = frame(value);
  expect(output).toContain(theme(3).paint("+42", "done"));
  expect(output).toContain("\u001b[38;2;255;122;112m−7");
  expect(output).toContain(theme(3).paint("▲ outside May change", "interrupted"));
  expect(output).toContain("\u001b[48;2;27;30;26m\u001b[1m\u001b[38;2;228;232;224m all ");
  expect(output.split("\n").find((line) => line.includes("src/client.ts"))).toContain(
    "\u001b[48;2;27;30;26m",
  );
  expect(
    frame({ ...value, filesFocused: false })
      .split("\n")
      .find((line) => line.includes("src/client.ts")),
  ).not.toContain("\u001b[48;2;27;30;26m");
});
it("keeps ordinary pane content visible when feed search is absent", () => {
  const value = model();
  expect(plain(frame({ ...value, feedTabs: null }))).toContain("checks passed");
});
it("keeps the focused feed visible below a full header and timeline", () => {
  const value = model(100);
  if (!value.detail) throw new Error("Expected detail");
  const output = plain(
    frame({
      ...value,
      rows: 24,
      detail: {
        ...value.detail,
        header: Array.from(
          { length: 10 },
          (_, index) => [`field ${index}`, `value ${index}`] as const,
        ),
        focus: "feed",
        panes: [
          {
            id: "task",
            title: "Task",
            value: "",
            lines: [],
            height: 20,
            offset: 0,
            focused: false,
          },
          {
            id: "feed",
            title: "Feed",
            value: "following",
            lines: [{ text: "focused feed content", tone: "fg" }],
            height: 5,
            offset: 0,
            focused: true,
          },
        ],
      },
    }),
  );
  expect(output).toContain("focused feed content");
  expect(output.split("\n").at(-2)?.trim()).toMatch(/^╰─+╯$/);
  expect(output.split("\n")).toHaveLength(24);
});
it.each([140, 100])(
  "keeps the following feed at its tail and preserves paused positions at %i columns",
  (columns) => {
    const value = model(columns);
    if (!value.detail) throw new Error("Expected detail");
    const pane = {
      id: "feed" as const,
      title: "Feed",
      value: "following",
      lines: Array.from({ length: 100 }, (_, index) => ({
        text: `event ${index + 1}`,
        tone: "fg" as const,
      })),
      height: 38,
      offset: 64,
      focused: true,
    };
    const detail = { ...value.detail, focus: "feed" as const, panes: [pane] };
    const following = plain(frame({ ...value, detail }));
    expect(following).toContain("event 100");
    const paused = plain(
      frame({ ...value, detail: { ...detail, panes: [{ ...pane, value: "paused", offset: 10 }] } }),
    );
    expect(paused).toContain("event 11");
    expect(paused).not.toContain("event 100");
  },
);
it.each([false, true])(
  "draws numbered, offset diff rows and truncation with NO_COLOR=%s",
  (noColor) => {
    const output = frame({ ...model(80), diff }, noColor);
    const text = plain(output);
    for (const label of [
      "src/client.ts · 1 of 3 · hunk 1 of 2",
      "n/p hunk",
      "@@ -41,2 +41,2 @@",
      "41",
      "-old",
      "+new",
      "…",
      "truncated",
    ])
      expect(text).toContain(label);
    expect(text).not.toContain("hidden before offset");
    expect(text).not.toContain("Timeline");
    expect(text.split("\n")).toHaveLength(40);
    for (const line of text.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(80);
    if (noColor) expect(output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(38|48);`));
    else
      for (const [label, tone] of [
        ["-old", "failed"],
        ["+new", "done"],
        ["@@ -41,2 +41,2 @@", "running"],
      ] as const)
        expect(output).toContain(theme(3).paint(label, tone));
  },
);
it("routes q, j and 1 to the feed search input instead of shortcuts", async () => {
  const keys: string[] = [];
  const changes: unknown[] = [];
  const value = model();
  const app = render(
    createElement(MonitorApp, {
      model: { ...value, feedTabs: { filter: "all", search: "", editing: true } },
      colors: theme(0),
      onKey: (key) => keys.push(key),
      onTick: () => {},
      onInspect: (message) => changes.push(message),
    }),
  );
  await expect.poll(() => app.lastFrame()).toContain("search feed");
  for (const key of ["q", "j", "1"]) {
    app.stdin.write(key);
    await expect.poll(() => changes).toContainEqual({ type: "feed-search-text", text: key });
  }
  expect(keys).toEqual([]);
});
