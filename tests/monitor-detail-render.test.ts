import chalk from "chalk";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import type { DetailFeed } from "../src/core/monitor/detail-feed";
import { EVENT_BUFFER_LIMIT, initialState, reduce, view } from "../src/core/monitor/model";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import {
  defaults,
  detail,
  detailEvents,
  detailLive,
  live,
  messageEvents,
  now,
  run,
} from "./helpers/monitor";

afterEach(cleanup);
const strip = (text: string) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const sample = detail();
const events = detailEvents();
function model(feed: DetailFeed, columns: number, keys: readonly string[] = [], rows = 40) {
  let state = initialState({
    group: "/repo",
    defaults,
    version: "0.1.3",
    now,
    columns,
    rows,
    name: sample.run.name,
  });
  state = reduce(state, { type: "feed", value: live([sample.run]) });
  state = reduce(state, { type: "detail-feed", name: sample.run.name, value: feed });
  for (const key of keys) state = reduce(state, { type: "key", key });
  return view(state);
}
async function frame(
  feed: DetailFeed,
  columns: number,
  keys: readonly string[] = [],
  color = false,
  noColor = false,
) {
  const previous = chalk.level;
  chalk.level = color ? 3 : 0;
  try {
    const value = model(feed, columns, keys);
    const rendered = render(
      createElement(Screen, { model: value, colors: theme(color ? 3 : 0, noColor) }),
    );
    Object.defineProperty(rendered.stdout, "columns", { get: () => columns });
    rendered.rerender(
      createElement(Screen, { model: value, colors: theme(color ? 3 : 0, noColor) }),
    );
    await expect.poll(() => rendered.lastFrame()).toBeTruthy();
    const result = rendered.lastFrame() ?? "";
    rendered.unmount();
    return result;
  } finally {
    chalk.level = previous;
  }
}
const feedKeys = Array.from({ length: 6 }, () => "tab");
describe("monitor detail frames", () => {
  it("renders a declined command as a failure rather than open work", async () => {
    const result = strip(
      await frame(
        detailLive(sample, [
          {
            seq: 1,
            at: sample.record.updatedAt,
            event: {
              _tag: "Command",
              command: "denied command",
              status: "declined",
              exitCode: null,
              outputTail: "",
            },
          },
        ]),
        100,
        feedKeys,
      ),
    );
    expect(result).toContain("× denied command");
    expect(result).not.toContain("… denied command");
  });
  it.each([70, 100])(
    "keeps detail connection notices visible while Feed is focused at %i columns",
    async (columns) => {
      const feeds: DetailFeed[] = [
        {
          _tag: "Saved",
          detail: sample,
          events: messageEvents(40),
          gap: false,
          receivedAt: now,
          reason: "no-daemon",
          nextProbeAt: now + 10000,
        },
        { _tag: "Reconnecting", last: sample, reason: "Socket unavailable", retryAt: now + 4000 },
      ];
      for (const feed of feeds) {
        const value = model(feed, columns, feedKeys);
        const result = strip(
          renderToString(createElement(Screen, { model: value, colors: theme(0) }), { columns }),
        );
        expect(result).toContain(
          feed._tag === "Saved" ? "Saved state · daemon not running" : "Reconnecting to daemon",
        );
        expect(result).toContain("following");
        expect(value.footer.status).toBe(
          feed._tag === "Saved" ? "saved · daemon not running" : "reconnecting in 4s",
        );
      }
    },
  );
  it.each([8, 12])("makes the last contract line reachable with End at %i rows", (rows) => {
    const contract = Array.from({ length: 20 }, (_, i) => `contract line ${i + 1}`).join("\n");
    const value = model(detailLive({ ...sample, contract }), 100, ["end"], rows);
    const result = strip(
      renderToString(createElement(Screen, { model: value, colors: theme(0) }), { columns: 100 }),
    );
    expect(result).toContain("contract line 20");
    expect(result.split("\n")).toHaveLength(rows);
  });
  it.each([70, 100, 140])("detail layout at %i columns", async (columns) => {
    for (const keys of [[], feedKeys]) {
      const result = strip(await frame(detailLive(sample, events), columns, keys));
      expect(result).toMatchSnapshot();
      for (const line of result.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(result.split("\n")).toHaveLength(40);
      if (keys.length || columns === 140) {
        for (const text of [
          "following",
          "✓ bun run lint",
          "×2 bun run test",
          "write src/hooks.ts",
          "hooks blocked",
          "question q1",
          "running → waiting",
          "q2 deferred",
        ])
          expect(result).toContain(text);
      }
    }
  });
  it.each([
    "starting",
    "running",
    "waiting",
    "idle",
    "failed",
    "interrupted",
    "unknown",
    "lost",
  ] as const)("%s colors", async (state) => {
    const result = await frame(
      detailLive(detail(run("fix-hooks", { state })), events),
      140,
      [],
      true,
    );
    expect(result).toMatchSnapshot();
    expect(result).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:2|3|5)m`));
  });
  it("uses foreground for focus and the run name, and orange only for attention", async () => {
    const result = await frame(detailLive(sample, events), 140, feedKeys, true);
    expect(result).toMatch(/38;2;228;232;224m[^\n]*Feed/);
    expect(result).toMatch(/38;2;228;232;224mfix-hooks/);
    expect(result).toMatch(/38;2;255;91;20m[^\n]*question q1/);
    expect(result).toMatch(/38;2;255;122;112m[^\n]*hooks blocked/);
    expect(result).toMatch(/38;2;228;232;224m \/root\/acceptance_tests/);
  });
  it("shows 30 feed entries and a paused header without losing its place", async () => {
    const feed = detailLive(sample, messageEvents(EVENT_BUFFER_LIMIT));
    const following = strip(await frame(feed, 100, feedKeys));
    const paused = strip(await frame(feed, 100, [...feedKeys, "f"]));
    expect(following).toMatchSnapshot();
    expect(paused).toMatchSnapshot();
    expect(following.match(/12:00:00 event/g)?.length).toBeGreaterThanOrEqual(30);
    expect(paused).toContain("paused · f to follow");
    expect(paused).toContain("event 1000");
  });
  const feeds: DetailFeed[] = [
    {
      _tag: "Saved",
      detail: sample,
      events,
      gap: false,
      receivedAt: now,
      reason: "no-daemon",
      nextProbeAt: now + 10000,
    },
    {
      _tag: "Saved",
      detail: sample,
      events,
      gap: true,
      receivedAt: now,
      reason: "outdated",
      nextProbeAt: now + 10000,
    },
    { _tag: "Reconnecting", last: sample, reason: "Connection lost", retryAt: now + 4000 },
    { _tag: "Reconnecting", last: null, reason: "Connection lost", retryAt: now + 4000 },
    { _tag: "Archived", receivedAt: now },
  ];
  for (const [index, feed] of feeds.entries()) {
    it.each([70, 100, 140])(`state block ${index} at %i columns`, async (columns) => {
      const result = await frame(feed, columns);
      expect(strip(result)).toMatchSnapshot();
      if (feed._tag === "Saved" || (feed._tag === "Reconnecting" && feed.last))
        expect(result).toContain("Task");
    });
    it(`state block ${index} colors`, async () =>
      expect(await frame(feed, 140, [], true)).toMatchSnapshot());
  }
  it("NO_COLOR keeps state and event glyphs readable", async () => {
    const result = await frame(detailLive(sample, events), 140, feedKeys, true, true);
    expect(result).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:38|48);`));
    for (const glyph of ["■", "…", "✓", "×2"]) expect(result).toContain(glyph);
    expect(strip(result)).toMatchSnapshot();
  });
  it("renders one hundred detail frames with a full buffer under 3 seconds", () => {
    const feed = detailLive(sample, messageEvents(EVENT_BUFFER_LIMIT));
    const start = performance.now();
    let result = "";
    for (let i = 0; i < 100; i++)
      result = renderToString(
        createElement(Screen, { model: model(feed, 140), colors: theme(0) }),
        { columns: 140 },
      );
    expect(performance.now() - start).toBeLessThan(3000);
    expect(result).toContain("event 1000");
  });
  it("collapses the detail footer below 24 rows", () => {
    const result = strip(
      renderToString(
        createElement(Screen, { model: model(detailLive(), 100, [], 20), colors: theme(0) }),
        { columns: 100 },
      ),
    );
    expect(result.split("\n").at(-1)?.trim()).toBe("? help  q quit");
  });
  it("keeps the reconnect state block in foreground while retained data is muted", async () => {
    const result = await frame(
      { _tag: "Reconnecting", last: sample, retryAt: now + 4000, reason: "Socket unavailable" },
      140,
      [],
      true,
    );
    expect(result).toMatch(/38;2;228;232;224mReconnecting to daemon/);
    expect(result).toMatch(/38;2;154;162;148m(?:│ )?# Fix hook handling/);
    expect(result).toMatch(/38;2;228;232;224m╭─[^\n]*Task/);
  });
  it("keeps note timestamps muted and regular while their badges show attention", async () => {
    const result = await frame(detailLive(sample, events), 140, feedKeys, true);
    expect(result).toMatch(/38;2;154;162;148m12:00:00[^\n]*38;2;255;91;20m■ question q1/);
  });
});
