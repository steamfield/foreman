import chalk from "chalk";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import type { DetailFeed } from "../src/core/monitor/detail-feed";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { EVENT_BUFFER_LIMIT } from "../src/core/monitor/model-types";
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
const paneFrame = (frame: string, title: string) => {
  const lines = strip(frame).split("\n");
  const start = lines.findIndex((line) => line.startsWith(`╭─ ${title} `));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("╰"));
  expect(end).toBeGreaterThan(start);
  return lines
    .slice(start, end + 1)
    .map((line) => line.trimEnd())
    .join("\n");
};
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
const feedKeys = Array.from({ length: 7 }, () => "tab");
describe("monitor detail frames", () => {
  it("keeps unfocused titles bold and readable while only the focused border is bright", async () => {
    const result = await frame(detailLive(sample, events), 140, [], true);
    expect(result).toContain("38;2;45;50;43m╭─ \u001b[1m\u001b[38;2;228;232;224mDigest");
    expect(result).toMatch(/38;2;228;232;224m╭─ [^\n]*Task/);
  });
  it("renders the model's selected Files pane, timeline and feed tabs together at 140x40", () => {
    const name = sample.run.name;
    let state = initialState({
      group: "/repo",
      defaults,
      version: "test",
      now,
      columns: 140,
      rows: 40,
      name,
    });
    state = reduce(state, { type: "detail-feed", name, value: detailLive(sample, events) });
    const id = state.detail?.changes?.id;
    if (id === undefined) throw new Error("Expected changes request");
    state = reduce(state, {
      type: "changes-result",
      id,
      error: null,
      files: [{ path: "src/client.ts", status: "modified", added: 42, removed: 7, outside: true }],
    });
    for (let index = 0; index < 6; index++) state = reduce(state, { type: "key", key: "tab" });
    const output = renderToString(createElement(Screen, { model: view(state), colors: theme(3) }), {
      columns: 140,
    });
    const text = strip(output);
    for (const label of [
      "Timeline",
      "Files · 1 changed",
      "src/client.ts",
      "▲ outside May change",
      "+42",
      "−7",
      "cmds",
      "files",
      "msgs",
      "q&a",
    ])
      expect(text).toContain(label);
    const feedBorder = text
      .split("\n")
      .find((line) => line.includes("╭─ Feed "))
      ?.split("╭─ Feed ")[1];
    expect(feedBorder).toBeDefined();
    expect(feedBorder?.match(/\ball\b/g)).toHaveLength(1);
    expect(output.split("\n").find((line) => line.includes("src/client.ts"))).toContain(
      "\u001b[48;2;27;30;26m",
    );
    expect(text.split("\n")).toHaveLength(40);
    for (const line of text.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(140);
    expect(text.replace(/ +$/gm, "")).toMatchSnapshot();
  });
  it("shows the selected filter in the narrow feed tabs", async () => {
    const result = await frame(detailLive(sample, events), 70, [...feedKeys, "2"], true);
    const border = result.split("\n").find((line) => strip(line).startsWith("╭─ Feed "));
    expect(border).toBeDefined();
    const esc = String.fromCharCode(27);
    expect(border).toMatch(new RegExp(`${esc}\\[48;2;27;30;26m(?:${esc}\\[[0-9;]*m)* cmds `));
  });
  it("shows header warnings, new files and the successful last command after an earlier failure", async () => {
    const data = detail(
      run("fix-hooks", {
        warnings: ["protocol mismatch", "MCP server docs failed to start"],
      }),
    );
    const commands = detailEvents()
      .filter((entry) => entry.event._tag === "Command")
      .reverse();
    const result = strip(
      await frame(
        detailLive(
          {
            ...data,
            digest: {
              ...data.digest,
              newInGitStatus: ["a.ts", "b.ts"],
              commands: {
                total: 2,
                failed: 1,
                blockedByHooks: 0,
                last: { command: "bun run lint", exitCode: 0 },
              },
            },
          },
          commands
            .filter(
              (entry) => entry.event._tag === "Command" && entry.event.status !== "inProgress",
            )
            .map((entry, index) => ({ ...entry, seq: index + 1 })),
        ),
        100,
      ),
    );
    expect(result).toContain("warning: protocol mismatch");
    expect(result).toContain("warning: MCP server docs failed to start");
    expect(result).toContain("commands  2 total · 1 failed · 0 hooks blocked");
    expect(result).toContain("last command  bun run lint · exit 0");
    expect(result).toContain("files  1 written · 0 outside May change · 2 new in git status");
    expect(result).toMatchSnapshot();
  });
  it.each([
    [0, "Task", "# Fix hook handling"],
    [1, "Digest", "750 cached (75% hit)"],
    [2, "Questions", "q1 · question · pending"],
    [3, "Subagents", "/root/acceptance_tests"],
    [4, "Hand-off", "Updated the hooks."],
    [5, "Commands", "foreman answer fix-hooks q1 --file <path>"],
    [6, "Files", "loading changes…"],
    [7, "Feed", "following"],
    [8, "Task", "# Fix hook handling"],
  ] as const)("Tab %i focuses %s and shows its content", async (tabs, title, text) => {
    const result = await frame(
      detailLive(sample, events),
      100,
      Array.from({ length: tabs }, () => "tab"),
      true,
    );
    expect(result).toMatch(new RegExp(`38;2;228;232;224m[^\\n]*╭─ [^\\n]*${title}`));
    expect(strip(result)).toContain(text);
    if (tabs < 8) expect(paneFrame(result, title)).toMatchSnapshot();
    if (title === "Questions") {
      const last = await frame(detailLive(sample, events), 100, ["tab", "tab", "end"]);
      expect(paneFrame(last, title)).toMatchSnapshot("resolved and cancelled questions");
    }
  });
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
    ...(["running", "starting"] as const).map(
      (state): DetailFeed => ({
        _tag: "Saved",
        detail: detail(run("fix-hooks", { state })),
        events,
        gap: false,
        receivedAt: now,
        reason: "no-daemon",
        nextProbeAt: now + 10000,
      }),
    ),
  ];
  for (const [index, feed] of feeds.entries()) {
    it(`state block ${index} at 100 columns`, async () => {
      const columns = 100;
      const result = await frame(feed, columns);
      expect(strip(result)).toMatchSnapshot();
      if (feed._tag === "Saved" || (feed._tag === "Reconnecting" && feed.last))
        expect(result).toContain("Task");
    });
    if (index < 3 || feed._tag === "Archived")
      it(`state block ${index} colors`, async () =>
        expect(await frame(feed, 140, [], true)).toMatchSnapshot());
  }
  it("NO_COLOR keeps state and event glyphs readable", async () => {
    const result = await frame(detailLive(sample, events), 140, feedKeys, true, true);
    expect(result).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:38|48);`));
    for (const glyph of ["■", "…", "✓", "×2"]) expect(result).toContain(glyph);
    expect(strip(result)).toMatchSnapshot();
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
