import chalk from "chalk";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorFeed } from "../src/core/monitor/feed";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { MonitorApp, Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { at, defaults, live, mixedRuns, now, overview, run, subagents } from "./helpers/monitor";

afterEach(() => cleanup());
const model = (feed: MonitorFeed | null, columns: number, key?: string, rows = 40) => {
  let state = initialState({ group: "/repo", defaults, version: "0.1.3", now, columns, rows });
  if (feed) state = reduce(state, { type: "feed", value: feed });
  if (key === "!") {
    state = { ...state, attentionOnly: true };
    state = { ...state, selected: view(state).groups[0]?.rows[0]?.name ?? null };
  } else if (key) state = reduce(state, { type: "key", key });
  return view(state);
};
const feeds: { name: string; feed: MonitorFeed | null; key?: string }[] = [
  { name: "probing", feed: null },
  { name: "list", feed: live(mixedRuns()) },
  { name: "attention", feed: live(mixedRuns()), key: "!" },
  { name: "help", feed: live(mixedRuns()), key: "?" },
  { name: "empty", feed: live([]) },
  {
    name: "all states",
    feed: live(
      (
        [
          "starting",
          "running",
          "waiting",
          "unknown",
          "idle",
          "failed",
          "interrupted",
          "lost",
        ] as const
      ).map((state) => run(state, { state })),
    ),
  },
  {
    name: "saved",
    feed: {
      _tag: "Saved",
      reason: "no-daemon",
      overview: { _tag: "Overview", daemon: null, runs: mixedRuns() },
      receivedAt: now,
      nextProbeAt: now + 10000,
    },
  },
  {
    name: "saved starting",
    feed: {
      _tag: "Saved",
      reason: "no-daemon",
      overview: { _tag: "Overview", daemon: null, runs: [run("starting", { state: "starting" })] },
      receivedAt: now,
      nextProbeAt: now + 10000,
    },
  },
  {
    name: "outdated active",
    feed: {
      _tag: "Saved",
      reason: "outdated",
      overview: { _tag: "Overview", daemon: null, runs: mixedRuns() },
      receivedAt: now,
      nextProbeAt: now + 10000,
    },
  },
  {
    name: "outdated",
    feed: {
      _tag: "Saved",
      reason: "outdated",
      overview: { _tag: "Overview", daemon: null, runs: [] },
      receivedAt: now,
      nextProbeAt: now + 10000,
    },
  },
  {
    name: "reconnecting",
    feed: {
      _tag: "Reconnecting",
      last: overview(mixedRuns()),
      retryAt: now + 4000,
      reason: "Connection lost",
    },
  },
  {
    name: "reconnecting without history",
    feed: { _tag: "Reconnecting", last: null, retryAt: now + 4000, reason: "Socket unavailable" },
  },
  {
    name: "saved empty",
    feed: {
      _tag: "Saved",
      reason: "no-daemon",
      overview: { _tag: "Overview", daemon: null, runs: [] },
      receivedAt: now,
      nextProbeAt: now + 10000,
    },
  },
];
async function frame(feed: MonitorFeed | null, columns: number, key?: string, color = false) {
  const previous = chalk.level;
  chalk.level = color ? 3 : 0;
  try {
    const rendered = render(
      createElement(Screen, { model: model(feed, columns, key), colors: theme(color ? 3 : 0) }),
    );
    Object.defineProperty(rendered.stdout, "columns", { get: () => columns });
    rendered.rerender(
      createElement(Screen, { model: model(feed, columns, key), colors: theme(color ? 3 : 0) }),
    );
    await expect.poll(() => rendered.lastFrame()).toBeTruthy();
    const result = rendered.lastFrame() ?? "";
    rendered.unmount();
    return result;
  } finally {
    chalk.level = previous;
  }
}
describe("monitor frames", () => {
  it.each([70, 80, 100, 140])(
    "keeps long state words and ages visible at %i columns",
    (columns) => {
      const output = renderToString(
        createElement(Screen, {
          model: model(live([run("long-state", { state: "interrupted" })]), columns),
          colors: theme(0),
        }),
        { columns },
      ).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
      expect(output).toMatch(/interrupted +12m/);
    },
  );
  it("renders the open command age in muted color", async () => {
    expect(await frame(live([run()]), 100, undefined, true)).toMatch(/38;2;154;162;148m · 20s/);
  });
  it("pulses a visible waiting note even when the run row is idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const value = model(
        live([run("pending", { state: "idle", questions: mixedRuns()[0]?.questions ?? [] })]),
        100,
      );
      expect(value.animating).toBe(true);
      const rendered = render(
        createElement(MonitorApp, {
          model: value,
          colors: theme(0),
          onKey: () => {},
          onTick: () => {},
        }),
      );
      await vi.waitFor(() => expect(rendered.lastFrame()).toContain("■ WAITING"));
      await vi.advanceTimersByTimeAsync(800);
      expect(rendered.lastFrame()).toContain("□ WAITING");
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("scrolls within a tall run to reach every subagent and back to the top", () => {
    let current = reduce(
      initialState({ group: "/repo", defaults, version: "0.1.3", now, columns: 100, rows: 24 }),
      { type: "feed", value: live([run("many", { subagents: subagents(24) })]) },
    );
    const frame = () =>
      renderToString(createElement(Screen, { model: view(current), colors: theme(0) }), {
        columns: 100,
      });
    expect(frame()).not.toContain("child-23");
    current = reduce(current, { type: "key", key: "page-down" });
    expect(frame()).toContain("child-23");
    expect(view(current).animating).toBe(false);
    current = reduce(current, { type: "key", key: "page-up" });
    expect(frame()).toContain("many");
  });
  it("uses one shared clock and stops it when the screen becomes idle", async () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const onTick = (time: number) => {
      ticks.push(time);
    };
    const onKey = () => {};
    try {
      const rendered = render(
        createElement(MonitorApp, {
          model: model(live([run("one"), run("two")]), 100),
          colors: theme(0),
          onTick,
          onKey,
        }),
      );
      await vi.waitFor(() => expect(rendered.lastFrame()).toContain("one"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toHaveLength(10);
      rendered.rerender(
        createElement(MonitorApp, {
          model: model(live([run("idle", { state: "idle" })]), 100),
          colors: theme(0),
          onTick,
          onKey,
        }),
      );
      await vi.waitFor(() => expect(rendered.lastFrame()).toContain("idle"));
      const count = ticks.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks).toHaveLength(count);
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it("fills every selected cell, closes note frames and preserves narrow urgency", async () => {
    const result = await frame(live(mixedRuns()), 140, "!", true);
    const selected = result
      .split("\n")
      .filter((line) => line.includes("fix-hooks") || line.includes("/root/"));
    for (const line of selected.filter((line) => !line.includes("╭") && !line.includes("answer")))
      expect(line).not.toContain("48;2;18;20;18");
    const plain = result.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    for (const line of plain
      .split("\n")
      .filter((line) => line.startsWith("│") || line.startsWith("╭")))
      expect(stringWidth(line.trimEnd())).toBe(140);
    const narrow = await frame(
      live([
        run("long", {
          questions: mixedRuns()[0]?.questions ?? [],
          subagents: mixedRuns()[0]?.subagents ?? [],
          activity: { kind: "command", text: "x".repeat(200), since: at() },
        }),
      ]),
      70,
    );
    expect(narrow).toMatch(/running +12m q2/);
    expect(narrow).toContain("2 subagents");
  });
  it("aligns durations and budgets", async () => {
    const result = (
      await frame(live([run("a"), run("long-name", { state: "starting" })]), 140)
    ).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    const rows = result.split("\n").filter((line) => line.includes("12/60m"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.indexOf("12/60m")).toBe(rows[1]?.indexOf("12/60m"));
  });
  it("shows the first-run instructions and setup commands with readable colors", async () => {
    const result = await frame(live([]), 100, undefined, true);
    const lines = result
      .split("\n")
      .filter((line) =>
        /No runs on|Ask it to delegate|foreman doctor|foreman skill install/.test(line),
      );
    expect(
      lines.map((line) =>
        line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").trim(),
      ),
    ).toEqual([
      "No runs on this machine yet.",
      "Runs are started by your coding agent. Ask it to delegate, for example:",
      "Check this repo is ready     foreman doctor",
      "Teach your agent foreman     foreman skill install",
    ]);
    for (const line of lines) expect(line).toContain("38;2;228;232;224m");
  });
  for (const fixture of feeds) {
    const widths = ["list", "all states"].includes(fixture.name) ? [70, 100, 140] : [100];
    it.each(widths)(`${fixture.name} at %i columns`, async (columns) => {
      const result = await frame(fixture.feed, columns, fixture.key);
      expect(
        result.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), ""),
      ).toMatchSnapshot();
      for (const line of result.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(result.split("\n").length).toBeLessThanOrEqual(40);
    });
    if (
      [
        "probing",
        "help",
        "empty",
        "all states",
        "saved",
        "outdated active",
        "reconnecting",
      ].includes(fixture.name)
    )
      it(`${fixture.name} colors`, async () => {
        expect(await frame(fixture.feed, 140, fixture.key, true)).toMatchSnapshot();
      });
  }
  it("keeps every state readable without color and never renders terminal controls from activity", async () => {
    const states = [
      "starting",
      "running",
      "waiting",
      "unknown",
      "idle",
      "failed",
      "interrupted",
      "lost",
    ] as const;
    const feed = live(
      states.map((state) =>
        run(state, {
          state,
          activity: { kind: "message", text: "wide 界é text\u001b[2J", since: at() },
        }),
      ),
    );
    const result = (await frame(feed, 100)).replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
      "",
    );
    for (const state of states) expect(result).toContain(state);
    for (const glyph of ["◐", "⣾", "■", "✓", "×", "◌"]) expect(result).toContain(glyph);
    expect(result).not.toContain("\u001b");
  });
});
