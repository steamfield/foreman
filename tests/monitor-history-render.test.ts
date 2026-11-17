import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { expect, it } from "vitest";
import { initialState, view } from "../src/core/monitor/model";
import type { HistoryView } from "../src/core/monitor/model-types";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, now } from "./helpers/monitor";

const row: HistoryView["rows"][number] = {
  name: "fix-hooks",
  repo: "foreman",
  task: "Repair hooks",
  outcome: "idle",
  tone: "done",
  ended: "2h ago",
  duration: "12m",
  turns: 2,
  tokens: "23k",
  archived: true,
};
function frame(columns: number, history: HistoryView) {
  const previous = chalk.level;
  chalk.level = 3;
  try {
    const model = {
      ...view(initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 30 })),
      history,
    };
    return renderToString(createElement(Screen, { model, colors: theme(3) }), { columns });
  } finally {
    chalk.level = previous;
  }
}
it.each([100, 140])(
  "renders history columns, state tones, archived marks and selection at %i",
  (columns) => {
    const output = frame(columns, {
      status: "ready",
      message: null,
      rows: [
        row,
        { ...row, name: "failed-run", outcome: "failed", tone: "failed", archived: false },
      ],
      selected: 0,
      offset: 0,
    });
    const lines = stripVTControlCharacters(output).split("\n");
    expect(lines[0]).toContain("History · 2 runs");
    expect(lines[1]?.trim().split(/ +/)).toEqual([
      "RUN",
      "REPO",
      "OUTCOME",
      "ENDED",
      "DURATION",
      "TURNS",
      "TOKENS",
      "TASK",
    ]);
    for (const value of [
      "fix-hooks",
      "foreman",
      "idle",
      "2h ago",
      "12m",
      "23k",
      "Repair hooks",
      "archived",
      "failed-run",
    ])
      expect(lines.join("\n")).toContain(value);
    expect(output).toContain("\u001b[38;2;92;201;138m");
    expect(output).toContain("\u001b[38;2;255;122;112m");
    expect(output).toContain("\u001b[38;2;154;162;148marchived");
    expect(output).toContain("\u001b[48;2;27;30;26m");
    expect(lines.at(-1)).toContain("jk move  / filter  h/esc back  ? help  q quit");
    expect(lines).toHaveLength(30);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
  },
);
for (const [status, message, expected] of [
  ["loading", null, "Loading history…"],
  ["failed", "History read failed: disk unavailable", "History read failed: disk unavailable"],
  ["ready", null, "No history runs."],
] as const) {
  it.each([100, 140])(`centres ${status} history at %i columns`, (columns) => {
    const lines = stripVTControlCharacters(
      frame(columns, { status, message, rows: [], selected: 0, offset: 0 }),
    ).split("\n");
    const index = lines.findIndex((line) => line.includes(expected));
    const line = lines[index] ?? "";
    expect(index).toBeGreaterThan(10);
    expect(index).toBeLessThan(19);
    expect(
      Math.abs(line.indexOf(expected) - (columns - stringWidth(expected)) / 2),
    ).toBeLessThanOrEqual(1);
    expect(lines).toHaveLength(30);
  });
}
