import { describe, expect, it } from "vitest";
import { initialState, reduce, type State, view } from "../src/core/monitor/model";
import type { HistoryEntry } from "../src/schemas/monitor";
import { at, defaults, live, now, run } from "./helpers/monitor";

const key = (state: State, key: string) => reduce(state, { type: "key", key });
const type = (state: State, text: string) => [...text].reduce(key, state);
const start = () =>
  reduce(initialState({ group: "/repo", defaults, version: "test", now, columns: 140, rows: 12 }), {
    type: "feed",
    value: live([run()]),
  });
const entry = (name = "finished", overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  name: run(name).name,
  repo: "/repo",
  title: "Fix hooks",
  state: "idle",
  archived: true,
  model: defaults.model,
  effort: defaults.effort,
  createdAt: at(-3600000),
  endedAt: at(-600000),
  turns: 3,
  tokensTotal: 12500,
  commands: null,
  filesWritten: null,
  dir: `/archive/${name}`,
  ...overrides,
});
const result = (
  state: State,
  entries: readonly HistoryEntry[] | null,
  error: string | null = null,
  id = state.history?.id ?? -1,
) => reduce(state, { type: "history-result", id, entries, error });

describe("monitor history", () => {
  it("opens a numbered loading request and increments the next id on reopening", () => {
    const state = key(start(), "h");
    expect(state.history).toEqual({ id: 1, entries: null, error: null, selected: 0 });
    expect(state.nextHistoryId).toBe(2);
    expect(view(state).history).toMatchObject({
      status: "loading",
      rows: [],
      selected: 0,
      offset: 0,
    });
    expect(key(key(state, "h"), "h").history?.id).toBe(2);
  });
  it.each(["escape", "h"])("returns to the selected list with %s", (shortcut) => {
    const before = start();
    const opened = result(key(before, "h"), [entry()]);
    expect(view(opened).history?.status).toBe("ready");
    const state = key(opened, shortcut);
    expect(view(state).history).toBeNull();
    expect(view(state).selected).toBe(before.selected);
  });
  it("ignores results for closed screens and stale requests", () => {
    const closed = key(key(start(), "h"), "escape");
    expect(result(closed, [entry()], null, 1)).toEqual(closed);
    const reopened = key(closed, "h");
    expect(result(reopened, null, "old failure", 1)).toEqual(reopened);
    expect(view(result(reopened, [entry()])).history?.status).toBe("ready");
  });
  it("reports read failures with their cause instead of an empty success", () => {
    const state = result(key(start(), "h"), null, "permission denied: archive");
    expect(view(state).history).toMatchObject({
      status: "failed",
      message: "Could not read run history: permission denied: archive",
      rows: [],
    });
  });
  it("reports a successfully read empty history", () => {
    const state = result(key(start(), "h"), []);
    expect(view(state).history).toMatchObject({
      status: "ready",
      message: "No finished runs yet.",
      rows: [],
    });
  });
  it.each([
    ["idle", "done", "done"],
    ["failed", "failed", "failed"],
    ["interrupted", "interrupted", "interrupted"],
    ["unknown", "unknown", "interrupted"],
    ["lost", "lost", "muted"],
  ] as const)("presents %s outcome, age, duration and compact tokens", (state, outcome, tone) => {
    const model = view(result(key(start(), "h"), [entry("finished", { state })]));
    expect(model.history?.rows).toEqual([
      {
        name: "finished",
        repo: "/repo",
        task: "Fix hooks",
        outcome,
        tone,
        ended: "10m ago",
        duration: "50m",
        turns: 3,
        tokens: "12.5K",
        archived: true,
      },
    ]);
  });
  it("preserves absent titles and unknown end times without inventing durations", () => {
    const model = view(
      result(key(start(), "h"), [
        entry("unknown", { endedAt: null, title: null, archived: false, tokensTotal: 1234567 }),
      ]),
    );
    expect(model.history?.rows[0]).toMatchObject({
      task: null,
      ended: "—",
      duration: "—",
      tokens: "1.2M",
      archived: false,
    });
  });
  it("moves through history with j/k, arrows, Home and End, clamps and scrolls", () => {
    const state = result(
      key(start(), "h"),
      Array.from({ length: 20 }, (_, i) => entry(`run-${i}`)),
    );
    expect(view(key(state, "up")).history?.selected).toBe(0);
    expect(view(key(key(state, "j"), "down")).history?.selected).toBe(2);
    expect(view(key(key(key(state, "j"), "down"), "k")).history?.selected).toBe(1);
    const end = key(state, "end");
    expect(view(key(end, "down")).history?.selected).toBe(19);
    expect(view(end).history?.offset).toBeGreaterThan(0);
    expect(view(key(end, "home")).history).toMatchObject({ selected: 0, offset: 0 });
    expect(view(end).selected).toBe("fix-hooks");
  });
  it.each([
    ["FINISHED", ["finished"]],
    ["migrate", ["other"]],
    ["repo:TOOLS", ["other"]],
    ["state:failed,idle repo:repo hooks", ["finished"]],
    ["state:failed", ["other"]],
    ["owner:alice", ["other"]],
  ])("filters history with %s", (text, expected) => {
    const state = result(key(start(), "h"), [
      entry(),
      entry("other", { state: "failed", repo: "/tools", title: "Migrate owner:alice" }),
    ]);
    const filtered = key(type(key(state, "/"), text), "enter");
    expect(view(filtered).history?.rows.map((row) => row.name)).toEqual(expected);
    expect(view(filtered).filterBar).toMatchObject({
      text,
      editing: false,
      shown: expected.length,
      total: 2,
    });
  });
  it("resets and clamps selection when filtering, and Escape restores rows", () => {
    const state = key(result(key(start(), "h"), [entry("a"), entry("b"), entry("c")]), "end");
    const filtered = type(key(state, "/"), "a");
    expect(view(filtered).history).toMatchObject({
      selected: 0,
      rows: [expect.objectContaining({ name: "a" })],
    });
    expect(view(key(filtered, "escape")).history?.rows).toHaveLength(3);
    expect(view(key(type(key(state, "/"), "zzzz"), "enter")).history).toMatchObject({
      selected: 0,
      rows: [],
    });
  });
  it("keeps history shortcuts in the filter and swallows list actions on history", () => {
    const state = result(key(start(), "h"), [entry()]);
    expect(type(key(state, "/"), "h?j").filter.text).toBe("h?j");
    expect(key(state, "s").act.overlay).toBeNull();
    expect(key(state, "enter").detail).toBeNull();
    expect(view(key(state, "?")).overlay).toBe(true);
  });
  it("sanitizes history text and failure messages for terminal display", () => {
    const state = key(start(), "h");
    expect(
      view(
        result(state, [entry("finished", { title: "Fix\u001b[2J\nhooks", repo: "/repo\u001b" })]),
      ).history?.rows[0],
    ).toMatchObject({ task: "Fix [2J hooks", repo: "/repo " });
    expect(view(result(state, null, "bad\u001b\nread")).history?.message).toBe(
      "Could not read run history: bad  read",
    );
  });
});
