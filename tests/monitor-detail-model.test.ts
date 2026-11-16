import { describe, expect, it } from "vitest";
import type { DetailFeed } from "../src/core/monitor/detail-feed";
import {
  DETAIL_PANES,
  EVENT_BUFFER_LIMIT,
  initialState,
  type PaneId,
  reduce,
  type State,
  stateTone,
  view,
} from "../src/core/monitor/model";
import { at, defaults, detail, detailLive, live, messageEvents, now, run } from "./helpers/monitor";

const key = (state: State, key: string) => reduce(state, { type: "key", key });
const start = (columns = 140, rows = 40) => {
  const data = detail();
  return reduce(
    initialState({
      group: "/repo",
      defaults,
      version: "0.1.3",
      now,
      columns,
      rows,
      name: data.run.name,
    }),
    { type: "detail-feed", name: data.run.name, value: detailLive(data) },
  );
};
const pane = (state: State, id: PaneId) =>
  view(state).detail?.panes.find((entry) => entry.id === id);
const focusFeed = (state: State) =>
  Array.from({ length: 6 }).reduce<State>((s) => key(s, "tab"), state);
describe("monitor detail model", () => {
  it.each(["running", "starting", "waiting"] as const)(
    "keeps saved %s work static only when no daemon supervises it",
    (runState) => {
      const data = detail(run("fix-hooks", { state: runState, subagents: detail().run.subagents }));
      for (const reason of ["no-daemon", "outdated"] as const) {
        const current = reduce(start(), {
          type: "detail-feed",
          name: data.run.name,
          value: {
            _tag: "Saved",
            detail: data,
            events: [],
            gap: false,
            receivedAt: now,
            reason,
            nextProbeAt: now + 10000,
          },
        });
        const model = view(current);
        expect(model.animating).toBe(reason === "outdated");
        expect(model.detail).toMatchObject({
          stale: reason === "no-daemon",
          tone: reason === "no-daemon" ? "muted" : stateTone(runState),
        });
        const agents = pane(current, "subagents")?.lines ?? [];
        expect(agents.some((line) => line.kind === "working")).toBe(reason === "outdated");
        expect(view(key(key(key(current, "tab"), "tab"), "tab")).animating).toBe(
          reason === "outdated",
        );
      }
    },
  );
  it.each([false, true])(
    "starts a fresh event buffer when a run name is reused (archived=%s)",
    (archived) => {
      const data = detail();
      let state = start();
      if (archived)
        state = reduce(state, {
          type: "detail-feed",
          name: data.run.name,
          value: { _tag: "Archived", receivedAt: now },
        });
      const replacement = {
        ...data,
        record: { ...data.record, createdAt: at(1000) },
        contract: "Replacement run",
      };
      state = reduce(state, {
        type: "detail-feed",
        name: data.run.name,
        value: detailLive(replacement, [
          {
            seq: 1,
            at: at(1000),
            event: { _tag: "AgentMessage", phase: null, text: "Fresh event" },
          },
        ]),
      });
      expect(pane(state, "task")?.lines.map((line) => line.text)).toEqual(["Replacement run"]);
      expect(pane(state, "feed")?.lines.map((line) => line.text)).toEqual(["Fresh event"]);
    },
  );
  it("opens Enter and closes Esc without losing list selection", () => {
    let state = reduce(
      initialState({ group: "/repo", defaults, version: "dev", now, columns: 100, rows: 40 }),
      { type: "feed", value: live([run("a"), run("b")]) },
    );
    state = key(state, "j");
    expect(view(state).selected).toBe("b");
    state = key(state, "enter");
    expect(view(state).detail?.name).toBe("b");
    expect(view(key(state, "escape")).selected).toBe("b");
    expect(view(key(state, "escape")).detail).toBeNull();
  });
  it("opens a startup name and cycles Tab in the prescribed order", () => {
    let state = start();
    expect(view(state).detail?.name).toBe("fix-hooks");
    for (const id of [...DETAIL_PANES, "task"]) {
      expect(view(state).detail?.focus).toBe(id);
      state = key(state, "tab");
    }
  });
  it("scrolls only the focused pane and pauses follow without moving the viewport", () => {
    let state = focusFeed(start());
    const tail = pane(state, "feed")?.offset;
    expect(tail).toBeGreaterThan(0);
    state = key(state, "f");
    expect(pane(state, "feed")?.offset).toBe(tail);
    expect(pane(state, "feed")?.value).toBe("paused · f to follow");
    state = key(state, "f");
    state = key(state, "k");
    expect(pane(state, "feed")?.offset).toBe((tail ?? 0) - 1);
    expect(pane(state, "feed")?.value).toBe("paused · f to follow");
    expect(pane(state, "task")?.offset).toBe(0);
    expect(pane(key(state, "home"), "feed")?.offset).toBe(0);
    expect(pane(key(state, "end"), "feed")?.offset).toBe(tail);
    expect(pane(key(state, "page-up"), "feed")?.offset).toBe(0);
    expect(pane(key(key(state, "home"), "page-down"), "feed")?.offset).toBe(tail);
    expect(pane(key(state, "f"), "feed")?.value).toBe("following");
  });
  it("keeps a bounded feed, deduplicates replayed events and retains gap information", () => {
    let state = start();
    state = reduce(state, {
      type: "detail-feed",
      name: detail().run.name,
      value: {
        ...detailLive(),
        _tag: "Live",
        detail: detail(),
        receivedAt: now,
        gap: true,
        events: messageEvents(EVENT_BUFFER_LIMIT + 5),
      },
    });
    const lines = pane(state, "feed")?.lines ?? [];
    expect(lines.filter((line) => line.at)).toHaveLength(EVENT_BUFFER_LIMIT);
    expect(lines[0]?.text).toContain("gap:");
    expect(lines[1]?.text).toContain("5 older events dropped");
    state = reduce(state, {
      type: "detail-feed",
      name: detail().run.name,
      value: detailLive(detail(), messageEvents(3, EVENT_BUFFER_LIMIT + 4)),
    });
    expect(pane(state, "feed")?.lines.filter((line) => line.at)).toHaveLength(EVENT_BUFFER_LIMIT);
    expect(pane(state, "feed")?.lines.at(-1)?.text).toBe(`event ${EVENT_BUFFER_LIMIT + 6}`);
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
  ] as const)("offers appropriate commands for %s and the local group", (status) => {
    const data = detail(run("local", { state: status }));
    const state = reduce(
      initialState({
        group: "/repo",
        defaults,
        version: "dev",
        now,
        columns: 100,
        rows: 40,
        name: data.run.name,
      }),
      { type: "detail-feed", name: data.run.name, value: detailLive(data) },
    );
    expect(pane(state, "commands")?.lines.map((line) => line.text)).toEqual([
      "foreman answer local q1 --file <path>",
      ...(["starting", "running", "waiting", "unknown"].includes(status)
        ? ["foreman interrupt local"]
        : []),
      "foreman result local",
      "foreman events local --follow",
    ]);
  });
  it("replaces other-group mutations and includes all question statuses and live digest data", () => {
    const data = detail(run("other", { group: "/other" }));
    let state = initialState({
      group: "/repo",
      defaults,
      version: "dev",
      now,
      columns: 100,
      rows: 40,
      name: data.run.name,
    });
    state = reduce(state, { type: "detail-feed", name: data.run.name, value: detailLive(data) });
    expect(pane(state, "commands")?.lines.map((line) => line.text)).toEqual([
      "other repo: its own session supervises it",
      "foreman result other",
      "foreman events other --follow",
    ]);
    for (const status of ["pending", "deferred", "resolved", "cancelled"])
      expect(pane(state, "questions")?.lines.some((line) => line.text.includes(status))).toBe(true);
    expect(
      pane(state, "digest")
        ?.lines.map((line) => line.text)
        .join("\n"),
    ).toContain("750 cached (75% hit)");
  });
  it("shows Saved, Reconnecting and Archived blocks and ignores a closed subscription", () => {
    const data = detail();
    const feeds: DetailFeed[] = [
      {
        _tag: "Saved",
        detail: data,
        events: [],
        gap: false,
        reason: "outdated",
        receivedAt: now,
        nextProbeAt: now + 10000,
      },
      { _tag: "Reconnecting", last: data, reason: "Connection lost", retryAt: now + 4000 },
      { _tag: "Archived", receivedAt: now },
    ];
    for (const value of feeds) {
      const state = reduce(start(), { type: "detail-feed", name: data.run.name, value });
      expect(view(state).detail?.message.length).toBeGreaterThan(0);
      const closed = key(state, "escape");
      expect(reduce(closed, { type: "detail-feed", name: data.run.name, value })).toBe(closed);
    }
  });
  it.each([70, 100, 140])(
    "uses the %i-column breakpoint and reserves 30 feed entries at 40 rows",
    (width) => {
      const state = start(width);
      expect(view(state).layout).toBe(
        new Map([
          [70, "narrow"],
          [100, "medium"],
          [140, "wide"],
        ]).get(width),
      );
      expect((pane(state, "feed")?.height ?? 0) - 2).toBeGreaterThanOrEqual(30);
      expect(view(start(width, 20)).footer.compact).toBe(true);
    },
  );
  it("reduces narrow subagents to a count and stops animating when only idle data is visible", () => {
    const data = detail(run("idle", { state: "idle", subagents: detail().run.subagents }));
    const state = reduce(
      initialState({
        group: "/repo",
        defaults,
        version: "dev",
        now,
        columns: 70,
        rows: 40,
        name: data.run.name,
      }),
      { type: "detail-feed", name: data.run.name, value: detailLive(data) },
    );
    expect(pane(state, "subagents")?.lines.map((line) => line.text)).toEqual(["2 subagents"]);
    expect(view(state).animating).toBe(false);
  });
  it("ticks a visible working subagent and stops when the feed covers the stack", () => {
    const data = detail(run("idle", { state: "idle", subagents: detail().run.subagents }));
    const state = reduce(
      initialState({
        group: "/repo",
        defaults,
        version: "dev",
        now,
        columns: 100,
        rows: 40,
        name: data.run.name,
      }),
      { type: "detail-feed", name: data.run.name, value: detailLive(data) },
    );
    expect(view(state).animating).toBe(true);
    expect(view(focusFeed(state)).animating).toBe(false);
  });
  it("preserves a paused feed anchor when a multi-line event falls out of the buffer", () => {
    const data = detail();
    let state = reduce(start(), {
      type: "detail-feed",
      name: data.run.name,
      value: detailLive(data, [
        {
          seq: 41,
          at: data.record.updatedAt,
          event: { _tag: "HookBlocked", event: "pre-commit", feedback: "Fix lint." },
        },
        ...messageEvents(EVENT_BUFFER_LIMIT - 1, 42),
      ]),
    });
    state = key(focusFeed(state), "f");
    const before = pane(state, "feed");
    const anchor = before?.lines[before.offset]?.text;
    expect(anchor).toMatch(/^event /);
    state = reduce(state, {
      type: "detail-feed",
      name: data.run.name,
      value: detailLive(data, messageEvents(1, EVENT_BUFFER_LIMIT + 41)),
    });
    const after = pane(state, "feed");
    expect(after?.lines[after.offset]?.text).toBe(anchor);
  });
});
