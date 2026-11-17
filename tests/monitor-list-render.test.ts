import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { expect, it } from "vitest";
import {
  initialState,
  type PreviewView,
  type RowView,
  type ViewModel,
  view,
} from "../src/core/monitor/model";
import { PinnedRows } from "../src/tui/pinned";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, now } from "./helpers/monitor";

const row: RowView = {
  name: "add-retry",
  stale: false,
  state: "running",
  turn: 2,
  turnKind: "followup",
  tone: "running",
  age: "12m",
  activity: "… bun run test",
  activityTone: "fg",
  activityAge: "20s",
  flags: [{ text: "read-only", tone: "muted" }],
  budget: { filled: 4, label: "24/60m", tone: "running" },
  subagents: [],
  task: "Retry failed daemon connects with backoff and preserve the wire protocol",
  modelLabel: "sol · high",
  progress: { text: "t2 · 31 cmds", failed: 3 },
  pace: "▂▃▅▆▇▇",
};
const groups = (rows: readonly RowView[]) => [
  { id: "repo", title: "repo", summary: "", older: null, rows },
];
const emptyPreview: PreviewView = {
  name: row.name,
  task: null,
  now: null,
  said: null,
  files: [],
  moreFiles: 0,
  outsideCount: 0,
};
function fixture(columns = 140): ViewModel {
  return {
    ...view(
      initialState({
        group: "/repo",
        defaults,
        version: "test",
        now,
        columns,
        rows: columns >= 120 ? 40 : 24,
      }),
    ),
    screen: "list",
    message: [],
    selected: row.name,
    listColumns: {
      task: true,
      model: columns >= 100,
      progress: columns >= 100,
      pace: columns >= 120,
      budgetLabel: columns >= 120,
    },
    budgetCells: columns >= 120 ? 10 : 6,
    groups: groups([row, { ...row, name: "docs-pass", age: "4m" }]),
    pinned: [
      {
        kind: "failed",
        name: "lint-sweep",
        text: "failed 8m ago · bun run check exited 1",
        tone: "failed",
        keys: [
          { key: "⏎", label: "open" },
          { key: "F", label: "follow up" },
        ],
      },
      {
        kind: "budget",
        name: "migrate-config",
        text: "90% of budget · 54/60m",
        tone: "interrupted",
        keys: [{ key: "i", label: "interrupt" }],
      },
      { kind: "quiet", name: "quiet-run", text: "quiet 6m", tone: "interrupted", keys: [] },
    ],
    preview: null,
  };
}
function frame(model: ViewModel, color = false) {
  const previous = chalk.level;
  chalk.level = color ? 3 : 0;
  try {
    return renderToString(createElement(Screen, { model, colors: theme(3, !color) }), {
      columns: model.columns,
    });
  } finally {
    chalk.level = previous;
  }
}
const plainLines = (text: string) => stripVTControlCharacters(text).split("\n");

it.each([140, 100, 80])("aligns the enabled columns at %i without wrapping rows", (columns) => {
  const model = fixture(columns);
  const lines = plainLines(frame(model));
  const header = lines.find((line) => line.includes("RUN")) ?? "";
  const rows = lines.filter((line) => / (add-retry|docs-pass)\s/.test(line));
  expect(rows).toHaveLength(2);
  const labels = [
    "RUN",
    ...(model.listColumns.model ? ["MODEL · EFFORT"] : []),
    "STATUS",
    "TASK",
    ...(model.listColumns.pace ? ["PACE"] : []),
    ...(model.listColumns.progress ? ["PROGRESS"] : []),
    "BUDGET",
    "FLAGS",
  ];
  expect(header.trim().split(/ {2,}/)).toEqual(labels);
  for (const [label, value] of [
    ["RUN", "add-retry"],
    ["STATUS", "running"],
    ["TASK", "Retry"],
    ["BUDGET", "━━━━"],
    ["FLAGS", "read-only"],
  ]) {
    expect(rows[0]?.indexOf(value ?? "")).toBe(header.indexOf(label ?? ""));
  }
  expect(rows[0]).toContain("…");
  expect(rows[0]?.indexOf("running")).toBe(rows[1]?.indexOf("running"));
  expect(rows[0]?.includes("sol · high")).toBe(model.listColumns.model);
  expect(rows[0]?.includes("31 cmds")).toBe(model.listColumns.progress);
  expect(rows[0]?.includes("▂▃▅▆▇▇")).toBe(model.listColumns.pace);
  expect(rows[0]?.includes("24/60m")).toBe(model.listColumns.budgetLabel);
  expect(lines).toHaveLength(model.rows);
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
});
it("omits the column header when all optional columns are hidden", () => {
  const model = fixture(80);
  expect(
    frame({
      ...model,
      listColumns: { task: false, model: false, pace: false, progress: false, budgetLabel: false },
    }),
  ).not.toContain("STATUS");
});
it("paints pace with the state tone, idle pace muted, and progress failures red", () => {
  const model = fixture();
  const output = frame(
    {
      ...model,
      groups: groups([row, { ...row, name: "idle", state: "idle", tone: "done" }]),
    },
    true,
  );
  expect(output).toContain("\u001b[38;2;111;168;255m▂▃▅▆▇▇");
  expect(output).toContain("\u001b[38;2;154;162;148m▂▃▅▆▇▇");
  expect(output).toContain("\u001b[38;2;255;122;112m ×3");
});
it("renders pinned rows with right-aligned bold keys, overflow count, and no signal tone", () => {
  const model = fixture();
  const previous = chalk.level;
  chalk.level = 3;
  try {
    const output = renderToString(
      createElement(PinnedRows, {
        pinned: model.pinned,
        morePinned: 2,
        width: 140,
        colors: theme(3),
      }),
      { columns: 140 },
    );
    const lines = plainLines(output);
    expect(lines.map((line) => line.trimEnd())).toEqual([
      ` × lint-sweep failed 8m ago · bun run check exited 1${" ".repeat(69)}⏎ open  F follow up`,
      ` ▲ migrate-config 90% of budget · 54/60m${" ".repeat(89)}i interrupt`,
      " ▲ quiet-run quiet 6m",
      "+2 more",
    ]);
    expect(output).toContain("\u001b[1m");
    expect(output).not.toContain("38;2;255;91;20");
    expect(output).toContain("38;2;226;192;79");
  } finally {
    chalk.level = previous;
  }
  const lines = plainLines(frame(model));
  expect(lines.findIndex((line) => line.includes("lint-sweep"))).toBeLessThan(
    lines.findIndex((line) => line.includes("── repo")),
  );
});
it("renders a three-row framed preview above the footer and shrinks the list", () => {
  const model = fixture();
  const tallGroups = groups(
    Array.from({ length: 20 }, (_, index) => ({ ...row, name: `run-${index}` })),
  );
  const preview = {
    name: "add-retry",
    task: "Retry with backoff",
    now: "… bun run test · 20s",
    said: "“Running the suite.” · 40s ago",
    files: [
      { path: "src/client.ts", outside: false },
      { path: "src/outside.ts", outside: true },
    ],
    moreFiles: 2,
    outsideCount: 1,
  };
  const output = frame({ ...model, groups: tallGroups, preview });
  const lines = plainLines(output);
  expect(lines.slice(-6).map((line) => line.trimEnd())).toEqual([
    expect.stringMatching(/^╭─ add-retry · preview .*⏎ open ─╮$/),
    expect.stringMatching(/^│ Task {3}Retry with backoff +│$/),
    expect.stringMatching(
      /^│ Now {4}… bun run test · 20s +Said {3}“Running the suite.” · 40s ago +│$/,
    ),
    expect.stringMatching(
      /^│ Files {2}src\/client.ts +▲ src\/outside.ts +2 more +1 outside scope +│$/,
    ),
    `╰${"─".repeat(138)}╯`,
    expect.stringContaining("quit"),
  ]);
  expect(lines).toHaveLength(40);
  expect(output).not.toContain("run-15");
  expect(frame({ ...model, groups: tallGroups })).toContain("run-15");
  expect(frame({ ...model, preview: { ...preview, outsideCount: 0 } })).toContain(
    "0 outside scope",
  );
  expect(frame(model)).not.toContain("· preview");
  expect(frame({ ...model, preview }, true)).toContain("\u001b[38;2;226;192;79m▲");
});
it("keeps the list, pinned rows and preview legible with NO_COLOR", () => {
  const output = frame({
    ...fixture(),
    preview: emptyPreview,
  });
  const plain = stripVTControlCharacters(output);
  for (const text of "⣾ add-retry|running| ×3|× lint-sweep|▲ migrate-config|Task|Now|Said|Files|0 outside scope|· preview|⏎ open".split(
    "|",
  ))
    expect(plain).toContain(text);
  expect(output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:38|48);`));
  expect(output).toContain("\u001b[7m");
});

it("keeps failure counts visible when progress text fills its column", () => {
  const model = fixture();
  const output = frame({
    ...model,
    groups: groups([{ ...row, progress: { text: "t123 · 12345 cmds", failed: 123 } }]),
  });
  expect(output).toContain(" ×123");
});

it("reserves preview space for the remaining-file count and outside-scope summary", () => {
  const output = frame({
    ...fixture(80),
    preview: {
      ...emptyPreview,
      files: [{ path: `src/${"long/".repeat(30)}client.ts`, outside: true }],
      moreFiles: 23,
      outsideCount: 4,
    },
  });
  const files = plainLines(output).find((line) => line.startsWith("│ Files"));
  expect(files).toMatch(/▲ .*… +23 more +4 outside scope +│$/);
});

it("aligns stale status and task cells with their column header", () => {
  const model = fixture(100);
  const lines = plainLines(
    frame({
      ...model,
      groups: groups([{ ...row, stale: true, tone: "muted" }]),
    }),
  );
  const header = lines.find((line) => line.includes("STATUS")) ?? "";
  const run = lines.find((line) => line.includes("not supervised")) ?? "";
  expect(run).toContain("not supervised");
  expect(run).toContain("Retry");
  expect(run.indexOf("Retry")).toBe(header.indexOf("TASK"));
});

it("shows all twelve pace buckets, including the most recent minutes", () => {
  const pace = "▁▂▃▄▅▆▇█▇▆▅▄";
  expect(frame({ ...fixture(), groups: groups([{ ...row, pace }]) })).toContain(pace);
});
