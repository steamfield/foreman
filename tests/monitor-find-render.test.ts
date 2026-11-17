import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, expect, it } from "vitest";
import { initialState, reduce, type ViewModel, view } from "../src/core/monitor/model";
import { GroupHeading } from "../src/tui/group-heading";
import { MonitorApp, Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, live, now, run } from "./helpers/monitor";

afterEach(cleanup);
it("keeps hidden waiting runs disclosed when visible runs fill the viewport", () => {
  const state = reduce(
    initialState({ group: "/repo", defaults, version: "test", now, columns: 100, rows: 30 }),
    { type: "feed", value: live(Array.from({ length: 25 }, (_, index) => run(`run-${index}`))) },
  );
  const output = stripVTControlCharacters(
    frame({ ...view(state), filterBar: fixture().filterBar, preview: null }),
  );
  const lines = output.split("\n");
  expect(lines).toHaveLength(30);
  expect(lines.at(-2)).toContain("■ 1 waiting run hidden by this filter · ! needs me");
});
it.each(["filter", "palette"] as const)(
  "keeps the caret and newly typed tail visible in a long %s query",
  async (kind) => {
    let model = {
      ...fixture(),
      filterBar: { text: "", editing: kind === "filter", shown: 1, total: 6, hiddenWaiting: 0 },
      palette: kind === "palette" ? { query: "", subject: null, items: [] } : null,
    };
    const texts: string[] = [];
    const props = () => ({
      model,
      colors: theme(0),
      onTick: () => {},
      onKey: () => {},
      onFind: (message: { type: "filter-text" | "palette-query"; text: string }) => {
        texts.push(message.text);
        model = {
          ...model,
          filterBar: { ...model.filterBar, text: message.text },
          palette: model.palette ? { ...model.palette, query: message.text } : null,
        };
        app.rerender(createElement(MonitorApp, props()));
      },
    });
    const app = render(createElement(MonitorApp, props()));
    await expect
      .poll(() => app.lastFrame())
      .toContain(kind === "palette" ? "Commands" : "esc clear");
    const text = `${"prefix ".repeat(20)}visible-tail`;
    app.stdin.write(text);
    await expect.poll(() => texts.at(-1)).toBe(text);
    await expect
      .poll(() => stripVTControlCharacters(app.lastFrame() ?? ""))
      .toContain("visible-tail");
    app.stdin.write("!");
    await expect.poll(() => texts.at(-1)).toBe(`${text}!`);
    await expect
      .poll(() => stripVTControlCharacters(app.lastFrame() ?? ""))
      .toContain("visible-tail!");
  },
);
it("keeps the primary action hints together when find hints are added", () => {
  const output = stripVTControlCharacters(frame({ ...fixture(), columns: 140 }));
  expect(output.split("\n").at(-1)).toContain("a answer  d defer  ! needs me");
  expect(output.split("\n").at(-1)).toContain("Enter open");
  expect(output.split("\n").at(-1)).toContain("s steer  i interrupt  F follow up  x archive");
});
it("keeps the reconnect countdown visible alongside the new list hints at 140 columns", () => {
  const base = fixture();
  const output = stripVTControlCharacters(
    frame({
      ...base,
      columns: 140,
      footer: { ...base.footer, status: "reconnecting in 4s", caution: true },
    }),
  );
  expect(output.split("\n").at(-1)).toContain("reconnecting in 4s");
});
function fixture(): ViewModel {
  return {
    ...view(
      initialState({ group: "/repo", defaults, version: "test", now, columns: 100, rows: 30 }),
    ),
    screen: "list",
    message: [],
    filterBar: {
      text: "state:running repo:claude-codex retry",
      editing: false,
      shown: 1,
      total: 6,
      hiddenWaiting: 1,
    },
    groups: [{ id: "repo", title: "claude-codex", summary: "1 running", rows: [], older: null }],
  };
}
function frame(model: ViewModel, noColor = false) {
  const previous = chalk.level;
  chalk.level = noColor ? 0 : 3;
  try {
    return renderToString(createElement(Screen, { model, colors: theme(3, noColor) }), {
      columns: model.columns,
    });
  } finally {
    chalk.level = previous;
  }
}
it("renders filter tokens as chips with counts immediately under the header", () => {
  const output = frame(fixture());
  const lines = stripVTControlCharacters(output).split("\n");
  expect(lines[1]).toContain("/  state:running   repo:claude-codex  retry");
  expect(lines[1]?.trimEnd()).toMatch(/1 of 6 runs · esc clear$/);
  expect(output.split("\n")[1]).toContain("\u001b[48;2;27;30;26m");
});
it("renders the hidden waiting warning in signal tone", () => {
  const output = frame(fixture());
  expect(stripVTControlCharacters(output)).toContain(
    "■ 1 waiting run hidden by this filter · ! needs me",
  );
  expect(output).toContain("\u001b[38;2;255;91;20m■ 1 waiting run hidden by this filter");
});
it("shows shown and hidden counts for a partly filtered group", () => {
  const output = renderToString(
    createElement(GroupHeading, {
      title: "repo",
      summary: "1 running",
      shown: 1,
      hidden: 4,
      width: 100,
      colors: theme(0),
    }),
    { columns: 100 },
  );
  expect(stripVTControlCharacters(output)).toMatch(/repo .*1 shown · 4 hidden by filter/);
});
it.each([false, true])(
  "renders the 100x30 palette board with selection, heading and aligned keys (NO_COLOR=%s)",
  (noColor) => {
    const model = fixture();
    const output = frame(
      {
        ...model,
        palette: {
          query: "int",
          subject: "add-retry",
          items: [
            {
              label: "interrupt add-retry",
              detail: "stops turn 1, keeps worktree",
              key: "i",
              selected: true,
              heading: false,
            },
            { label: "other actions", detail: "", key: null, selected: false, heading: true },
            { label: "steer add-retry", detail: "", key: "s", selected: false, heading: false },
          ],
        },
      },
      noColor,
    );
    const lines = stripVTControlCharacters(output).split("\n");
    expect(lines).toHaveLength(30);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(100);
    expect(lines.find((line) => line.includes("Commands"))).toMatch(
      / {14}╭─ Commands · add-retry selected/,
    );
    expect(lines.some((line) => line.includes(": int"))).toBe(true);
    expect(lines.some((line) => /│ ─+ │/.test(line))).toBe(true);
    const selected = lines.find((line) => line.includes("▸ interrupt")) ?? "";
    expect(selected).toContain("stops turn 1, keeps worktree");
    expect(selected.indexOf("i", selected.indexOf("worktree"))).toBe(
      (lines.find((line) => line.includes("steer add")) ?? "").lastIndexOf("s"),
    );
    expect(output).toContain(noColor ? "\u001b[7m" : "\u001b[48;2;27;30;26m");
    if (noColor) expect(output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:38|48);`));
    expect(lines.at(-1)).toContain(": palette open  ↑↓ choose  ⏎ run  esc close");
    expect(output).toContain("other actions");
  },
);
it.each(["filter", "palette"] as const)(
  "edits the %s input without triggering list shortcuts",
  async (kind) => {
    let model = fixture();
    model = {
      ...model,
      filterBar: { text: "", editing: kind === "filter", shown: 0, total: 0, hiddenWaiting: 0 },
      palette: kind === "palette" ? { query: "", subject: null, items: [] } : null,
    };
    const keys: string[] = [];
    const texts: string[] = [];
    const props = () => ({
      model,
      colors: theme(0),
      onTick: () => {},
      onKey: (key: string) => keys.push(key),
      onFind: (message: { type: "filter-text" | "palette-query"; text: string }) => {
        texts.push(message.text);
        model = {
          ...model,
          filterBar: model.filterBar ? { ...model.filterBar, text: message.text } : null,
          palette: model.palette ? { ...model.palette, query: message.text } : null,
        };
        app.rerender(createElement(MonitorApp, props()));
      },
    });
    const app = render(createElement(MonitorApp, props()));
    await expect
      .poll(() => app.lastFrame())
      .toContain(kind === "palette" ? "Commands" : "esc clear");
    for (const [index, key] of ["q", "j", "a", "s"].entries()) {
      app.stdin.write(key);
      await expect.poll(() => texts.at(-1)).toBe("qjas".slice(0, index + 1));
    }
    app.stdin.write("\r");
    app.stdin.write("\u001b");
    await expect.poll(() => keys).toEqual(["enter", "escape"]);
    expect(texts).toEqual(["q", "qj", "qja", "qjas"]);
  },
);
it("lists find keys in help and drops filter and palette hints before defer as width shrinks", () => {
  const base = fixture();
  const output = stripVTControlCharacters(frame({ ...base, rows: 40, overlay: true }));
  for (const text of ["/ filter", ": palette", "g group", "h history", "! needs me"])
    expect(output).toContain(text);
  const wide = stripVTControlCharacters(frame({ ...base, columns: 140 }))
    .split("\n")
    .at(-1);
  expect(wide).toContain("/ filter  : palette");
  const narrow = stripVTControlCharacters(frame({ ...base, columns: 80 }))
    .split("\n")
    .at(-1);
  expect(narrow).toContain("d defer");
  expect(narrow).not.toContain("/ filter");
});
