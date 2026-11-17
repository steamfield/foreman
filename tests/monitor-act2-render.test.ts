import { stripVTControlCharacters as plain } from "node:util";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, expect, it } from "vitest";
import { type ActMessage, type ActView, watchingView } from "../src/core/monitor/act";
import { initialState, reduce, type ViewModel, view } from "../src/core/monitor/model";
import { MonitorApp, Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, detailLive, now, run } from "./helpers/monitor";

afterEach(cleanup);
const compose: NonNullable<ActView["compose"]> = {
  title: "Steer migrate-config",
  meta: "turn 3 · running",
  draft: "Keep the public API.",
  sending: false,
};
const composing: ActView = { ...watchingView, compose };
const interrupt: NonNullable<ActView["confirm"]> = {
  title: "Interrupt migrate-config?",
  lines: [
    "Stops turn 3 now. Codex writes a hand-off; the worktree and branch stay.",
    "The open command",
    "  bun run test  running 40s, will be killed",
    "used      54 of 60 min · 88 commands · 1 file outside scope",
    "owner     a Claude Code session started this run. It will see interrupted from monitor.",
  ],
  keys: [
    { key: "y", label: "interrupt" },
    { key: "s", label: "steer instead" },
    { key: "n", label: "cancel" },
  ],
};
function model(act = watchingView, columns = 140, rows = 40): ViewModel {
  return {
    ...view(initialState({ group: "/repo", defaults, version: "test", now, columns, rows })),
    act,
    animating: false,
  };
}
function frame(value: ViewModel, noColor = false) {
  return renderToString(createElement(Screen, { model: value, colors: theme(3, noColor) }), {
    columns: value.columns,
  });
}

it.each([
  [140, 40],
  [80, 24],
])("frames compose at %ix%i with metadata, draft and actions", (columns, rows) => {
  const output = plain(frame(model(composing, columns, rows)));
  const lines = output.split("\n");
  expect(lines).toHaveLength(rows ?? 0);
  expect(output).toContain(compose.title);
  expect(output).toContain(compose.meta);
  expect(output).toContain(compose.draft);
  expect(lines.find((line) => line.includes("╭"))).toContain("╮");
  expect(lines.find((line) => line.includes("enter send"))).toMatch(/│.*ctrl-e.*esc cancel.*│/);
  expect(output).toContain("╰");
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns ?? 0);
});
it.each(["interrupt", "archive"])(
  "renders %s confirm keys with a primary fill and no orange",
  (kind) => {
    const confirm =
      kind === "interrupt"
        ? interrupt
        : {
            title: "Archive migrate-config?",
            lines: ["Archive this run and remove its worktree."],
            keys: [
              { key: "y", label: "archive" },
              { key: "k", label: "keep worktree" },
              { key: "n", label: "cancel" },
            ],
          };
    const output = frame(model({ ...watchingView, confirm }));
    expect(plain(output)).toContain(confirm.title);
    for (const line of confirm.lines)
      expect(plain(output).replace(/\s+/g, " ")).toContain(line.trim().replace(/\s+/g, " "));
    const overlay = output
      .split("\n")
      .filter((line) => /[╭│╰]/.test(plain(line)))
      .join("\n");
    expect(overlay).toContain(`\u001b[48;2;27;30;26m`);
    expect(plain(output)).toContain(` y ${kind} `);
    expect(plain(output)).toContain(kind === "interrupt" ? "s steer instead" : "k keep worktree");
    expect(overlay).not.toContain("38;2;255;91;20m");
  },
);
it.each(["interrupt", "archive"])("keeps %s confirm legible with NO_COLOR", (kind) => {
  const confirm = {
    ...interrupt,
    title: `${kind} migrate-config?`,
    keys: [
      { key: "y", label: kind },
      { key: "n", label: "cancel" },
    ],
  };
  const output = frame(model({ ...watchingView, confirm }, 80, 24), true);
  expect(output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:38|48);`));
  expect(output).toContain("\u001b[1m");
  expect(plain(output)).toContain(`y ${kind}`);
  expect(plain(output)).toContain("n cancel");
  expect(plain(output)).toContain("╰");
});
it("routes confirm y/k/s/n/escape to the app", async () => {
  const keys: string[] = [];
  const app = render(
    createElement(MonitorApp, {
      model: model({ ...watchingView, confirm: interrupt }),
      colors: theme(0),
      onKey: (key) => keys.push(key),
      onTick: () => {},
    }),
  );
  await expect.poll(() => app.lastFrame()).toContain(interrupt.title);
  for (const [index, key] of ["y", "k", "s", "n", "\u001b"].entries()) {
    app.stdin.write(key);
    await expect.poll(() => keys.length).toBe(index + 1);
  }
  expect(keys).toEqual(["y", "k", "s", "n", "escape"]);
});
it("types action letters into compose and routes controls without changing the draft", async () => {
  let current = model({ ...composing, compose: { ...compose, draft: "AB" } });
  const keys: string[] = [];
  const messages: ActMessage[] = [];
  const props = () => ({
    model: current,
    colors: theme(0),
    onKey: (key: string) => keys.push(key),
    onTick: () => {},
    onAct: (message: ActMessage) => {
      messages.push(message);
      if (message.type === "draft") {
        current = {
          ...current,
          act: { ...current.act, compose: { ...compose, draft: message.text } },
        };
        app.rerender(createElement(MonitorApp, props()));
      }
    },
  });
  const app = render(createElement(MonitorApp, props()));
  await expect.poll(() => app.lastFrame()).toContain(compose.title);
  app.stdin.write("\u001b[D");
  await expect.poll(() => app.lastFrame()).toMatch(/AB/);
  app.stdin.write("\u0005");
  await expect.poll(() => keys).toEqual(["ctrl-e"]);
  expect(messages).toEqual([]);
  for (const key of ["q", "j", "a", "s", "i"]) {
    app.stdin.write(key);
    await expect.poll(() => messages.length).toBe(["q", "j", "a", "s", "i"].indexOf(key) + 1);
  }
  expect(messages.at(-1)).toEqual({ type: "draft", text: "ABqjasi" });
  for (const [index, key] of ["\u0013", "\u001b", "\u0003"].entries()) {
    app.stdin.write(key);
    await expect.poll(() => keys.length).toBe(index + 2);
  }
  expect(keys).toEqual(["ctrl-e", "ctrl-s", "escape", "ctrl-c"]);
  expect(messages).toHaveLength(5);
});
it("keeps a long compose draft's tail and caret visible", async () => {
  const draft = `${"Preserve compatibility. ".repeat(25)}visible tail`;
  const app = render(
    createElement(MonitorApp, {
      model: model({ ...composing, compose: { ...compose, draft } }, 80, 24),
      colors: theme(0),
      onKey: () => {},
      onTick: () => {},
    }),
  );
  await expect.poll(() => plain(app.lastFrame() ?? "")).toContain("visible tail");
});
it.each([false, true])(
  "fits new footer actions in list/detail=%s and preserves compact mode",
  (detail) => {
    for (const [columns, rows] of [
      [100, 40],
      [140, 40],
      [80, 23],
    ] as const) {
      const base = model(watchingView, columns, rows);
      const value = detail
        ? {
            ...base,
            detail: view(
              reduce(
                initialState({
                  group: "/repo",
                  defaults,
                  version: "test",
                  now,
                  columns,
                  rows,
                  name: run().name,
                }),
                { type: "detail-feed", name: run().name, value: detailLive() },
              ),
            ).detail,
          }
        : base;
      const footer = plain(frame(value)).split("\n").at(-1) ?? "";
      if (rows < 24) expect(footer.trim()).toBe("? help  q quit");
      else {
        expect(footer).toContain("s steer  i interrupt");
        expect(footer.includes("F follow up")).toBe(columns === 140);
        expect(footer.includes("x archive")).toBe(columns === 140);
      }
      expect(stringWidth(footer)).toBeLessThanOrEqual(columns);
    }
  },
);
it("lists s, F, i, x and ctrl-e in help", () => {
  const output = plain(frame({ ...model(), overlay: true }));
  for (const text of ["s steer", "F follow up", "i interrupt", "x archive", "ctrl-e"])
    expect(output).toContain(text);
});
it("shows confirm actions once when a view still includes a duplicated keys line", () => {
  const keysLine = "y interrupt  s steer instead  n cancel";
  const output = plain(
    frame(
      model({ ...watchingView, confirm: { ...interrupt, lines: [...interrupt.lines, keysLine] } }),
    ),
  );
  expect(output.match(/y interrupt/g)).toHaveLength(1);
});
