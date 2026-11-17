import { describe, expect, it } from "vitest";
import type { DetailFeed } from "../src/core/monitor/detail-feed";
import type { MonitorFeed } from "../src/core/monitor/feed";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { PACE_MINUTES, type RunView } from "../src/schemas/monitor";
import {
  at,
  defaults,
  detail,
  detailLive,
  live,
  messageEvents,
  now,
  overview,
  run,
} from "./helpers/monitor";

const state = (runs: readonly RunView[] = [run()], columns = 140, rows = 40) =>
  reduce(initialState({ group: "/repo", defaults, version: "test", now, columns, rows }), {
    type: "feed",
    value: live(runs),
  });
const rows = (current: ReturnType<typeof state>) => view(current).groups.flatMap((g) => g.rows);
const preview = (data = detail(run()), events = messageEvents(40)) =>
  reduce(state([data.run]), {
    type: "preview-feed",
    name: data.run.name,
    value: detailLive(data, events),
  });
const saved = (runs: readonly RunView[]): MonitorFeed => ({
  _tag: "Saved",
  reason: "no-daemon",
  overview: { _tag: "Overview", daemon: null, runs },
  receivedAt: now,
  nextProbeAt: now + 10000,
});

describe("monitor list columns and row facts", () => {
  it("shows the title with controls replaced and preserves an absent title", () => {
    expect(rows(state([run("title", { title: "Fix\u001b hooks\nnow" })]))[0]?.task).toBe(
      "Fix  hooks now",
    );
    expect(rows(state([run("untitled", { title: null })]))[0]?.task).toBeNull();
  });
  it.each([
    ["gpt-6.1-sol", "medium", "sol · med"],
    ["gpt-6-luna", "low", "luna · low"],
    ["gpt-6.1-sol", "high", "sol · high"],
    ["gpt-6.1-sol", "xhigh", "sol · xhigh"],
    ["custom-model", "ultra", "custom-model · ultra"],
  ])("labels %s at %s effort", (model, effort, expected) => {
    expect(rows(state([run("model", { model, effort })]))[0]?.modelLabel).toBe(expected);
  });
  it("shows turn and command totals with failures separately, or null when unknown", () => {
    expect(
      rows(state([run("known", { commands: { total: 14, failed: 2 } })]))[0]?.progress,
    ).toEqual({ text: "t2 · 14 cmds", failed: 2 });
    expect(rows(state())[0]?.progress).toBeNull();
  });
  it("scales twelve pace cells to the run maximum and draws zero windows flat", () => {
    const pace = [0, 1, 2, 3, 4, 5, 6, 7, 0, 7, 1, 0];
    expect(rows(state([run("pace", { pace })]))[0]?.pace).toBe("▁▂▃▄▅▆▇█▁█▂▁");
    expect(rows(state([run("scaled", { pace: pace.map((n) => n * 20) })]))[0]?.pace).toBe(
      "▁▂▃▄▅▆▇█▁█▂▁",
    );
    expect(rows(state([run("zero", { pace: Array(PACE_MINUTES).fill(0) })]))[0]?.pace).toBe(
      "▁".repeat(PACE_MINUTES),
    );
  });
  it("uses a dot for inactive runs without live pace and null for unknown live activity", () => {
    expect(rows(state([run("idle", { state: "idle" })]))[0]?.pace).toBe("·");
    expect(rows(state())[0]?.pace).toBeNull();
    const entries = [
      run("active", { pace: Array(PACE_MINUTES).fill(3) }),
      run("idle", { state: "idle", pace: [3] }),
    ];
    const current = state(entries);
    expect(
      rows(reduce(current, { type: "feed", value: saved(entries) })).map((r) => r.pace),
    ).toEqual([null, "·"]);
    const reconnecting = reduce(current, {
      type: "feed",
      value: {
        _tag: "Reconnecting",
        last: overview([run("idle", { state: "idle", pace: [3] })]),
        reason: "socket closed",
        retryAt: now + 1000,
      },
    });
    expect(rows(reconnecting)[0]?.pace).toBe("·");
  });
  it.each([
    [79, { task: false, model: false, progress: false, pace: false, budgetLabel: false }],
    [80, { task: true, model: false, progress: false, pace: false, budgetLabel: false }],
    [90, { task: true, model: true, progress: false, pace: false, budgetLabel: false }],
    [100, { task: true, model: true, progress: true, pace: false, budgetLabel: false }],
    [120, { task: true, model: true, progress: true, pace: true, budgetLabel: false }],
    [140, { task: true, model: true, progress: true, pace: true, budgetLabel: true }],
  ])("selects optional columns at %i columns", (width, expected) => {
    const current = state(undefined, width);
    expect(view(current).listColumns).toEqual(expected);
    expect(rows(current)[0]).toMatchObject({ name: "fix-hooks", state: "running", age: "  12m" });
  });
  it("limits eighty-column flags to the most urgent one", () => {
    expect(
      rows(state([run("flags", { hooksBlocked: 1, unansweredCount: 2 })], 80))[0]?.flags,
    ).toEqual([{ text: "1 hooks blocked", tone: "failed" }]);
  });
  it.each([
    [140, 30, 24, 46, true],
    [140, 29, 20, 46, false],
    [79, 30, 23, 45, true],
  ] as const)(
    "keeps the last run visible with pins and optional frames at %ix%i",
    (columns, height, offset, end, hasPreview) => {
      const entries = [
        ...Array.from({ length: 4 }, (_, i) => run(`failed-${i}`, { state: "failed" })),
        ...Array.from({ length: 16 }, (_, i) =>
          run(`run-${String(i).padStart(2, "0")}`, { state: "idle" }),
        ),
      ];
      const model = view(reduce(state(entries, columns, height), { type: "key", key: "end" }));
      expect(model.selected).toBe("run-15");
      expect(model).toMatchObject({ morePinned: 1, offset });
      expect(model.pinned).toHaveLength(3);
      expect(model.preview !== null).toBe(hasPreview);
      expect(model.offset).toBeLessThanOrEqual(end - 2);
      expect(end).toBeLessThanOrEqual(model.offset + height - 2 - (hasPreview ? 5 : 0));
      expect(model.animating).toBe(false);
    },
  );
  it("pages by the list height remaining above the preview strip", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      run(`run-${String(i).padStart(2, "0")}`, { state: "idle" }),
    );
    const next = reduce(state(entries, 140, 30), { type: "key", key: "page-down" });
    expect(view(next).offset).toBe(23);
    expect(view(reduce(next, { type: "key", key: "page-up" })).offset).toBe(0);
  });
});

describe("monitor pinned attention", () => {
  it("pins failed, budget and quiet reasons in order with text and action keys", () => {
    const model = view(
      state([
        run("quiet", {
          quiet: true,
          activity: { kind: "message", text: "Checking\nmore", since: at(-360000) },
          lastActivityAt: at(-360000),
        }),
        run("budget", { turnStartedAt: at(-3240000) }),
        run("failed", {
          state: "failed",
          stateSince: at(-480000),
          failure: { message: "lint\u001b failed\nstack trace", hint: null },
        }),
      ]),
    );
    expect(model.pinned.map((p) => [p.kind, p.name, p.tone, p.text])).toEqual([
      ["failed", "failed", "failed", "failed 8m ago · lint  failed"],
      [
        "budget",
        "budget",
        "interrupted",
        "90% of budget · 54/60m · moves to a read-only hand-off turn at 60m",
      ],
      ["quiet", "quiet", "interrupted", "quiet 6m · Checking"],
    ]);
    expect(model.pinned.map((p) => p.keys.map((k) => `${k.key} ${k.label}`))).toEqual([
      ["⏎ open", "F follow up"],
      ["s steer", "i interrupt"],
      ["s steer", "i interrupt"],
    ]);
    expect(model).toMatchObject({ morePinned: 0 });
  });
  it("includes exactly 80% and overdue active budgets, excluding inactive and under-budget runs", () => {
    const model = view(
      state([
        run("edge", { turnStartedAt: at(-2880000) }),
        run("over", { turnStartedAt: at(-3660000) }),
        run("under", { turnStartedAt: at(-2879999) }),
        run("done", { state: "idle", turnStartedAt: at(-3600000) }),
      ]),
    );
    expect(model.pinned.map((p) => p.name)).toEqual(["over", "edge"]);
    expect(model.pinned[0]?.text).toContain("101% of budget");
  });
  it("sorts oldest first within each kind, caps rows at three and counts the rest", () => {
    const model = view(
      state([
        run("new-failure", { state: "failed", stateSince: at(-60000) }),
        run("older-failure", { state: "failed", stateSince: at(-120000) }),
        run("budget", { turnStartedAt: at(-3600000) }),
        run("quiet", { quiet: true, activity: null, lastActivityAt: at(-360000) }),
      ]),
    );
    expect(model.pinned.map((p) => p.name)).toEqual(["older-failure", "new-failure", "budget"]);
    expect(model).toMatchObject({ morePinned: 1 });
    expect(view(state())).toMatchObject({ pinned: [], morePinned: 0 });
  });
  it("suppresses quiet warnings for open commands and unsupervised active work", () => {
    const current = state([
      run("command", { quiet: true }),
      run("stale", {
        quiet: true,
        activity: null,
        lastActivityAt: at(-360000),
        turnStartedAt: at(-3600000),
      }),
    ]);
    expect(view(current).pinned.map((p) => p.name)).toEqual(["stale", "stale"]);
    const next = reduce(current, {
      type: "feed",
      value: saved([run("stale", { quiet: true, activity: null, turnStartedAt: at(-3600000) })]),
    });
    expect(view(next).pinned).toEqual([]);
  });
  it("describes the last activity when a quiet run has no activity text", () => {
    expect(
      view(state([run("quiet", { quiet: true, activity: null, lastActivityAt: at(-360000) })]))
        .pinned[0]?.text,
    ).toBe("quiet 6m · last activity 6m ago");
  });
  it("attention-only includes question or pin candidates, including hidden pins, and excludes flags alone", () => {
    const q = detail().run.questions;
    const current = reduce(
      state([
        run("question", { questions: q }),
        run("failed", { state: "failed" }),
        run("failed-two", { state: "failed" }),
        run("budget", { turnStartedAt: at(-3600000) }),
        run("quiet", { quiet: true, activity: null, lastActivityAt: at(-360000) }),
        run("flags-only", { hooksBlocked: 1, unansweredCount: 2, state: "interrupted" }),
        run("normal"),
      ]),
      { type: "key", key: "!" },
    );
    expect(
      rows(current)
        .map((r) => r.name)
        .sort(),
    ).toEqual(["budget", "failed", "failed-two", "question", "quiet"]);
    expect(view(current).notes).toHaveLength(1);
    expect(view(current)).toMatchObject({ morePinned: 1 });
  });
});

describe("monitor selected preview", () => {
  it("tracks selection, ignores other feeds and resets the feed when selection changes", () => {
    const first = run("first"),
      second = run("second");
    let current = state([first, second]);
    expect(current.preview).toEqual({ name: first.name, feed: null, commentary: null });
    expect(
      reduce(current, {
        type: "preview-feed",
        name: second.name,
        value: detailLive(detail(second)),
      }),
    ).toBe(current);
    current = reduce(current, {
      type: "preview-feed",
      name: first.name,
      value: detailLive(detail(first)),
    });
    expect(view(current).preview?.name).toBe("first");
    current = reduce(current, { type: "key", key: "j" });
    expect(current.preview).toEqual({ name: second.name, feed: null, commentary: null });
    expect(view(current).preview?.said).toBeNull();
    current = reduce(current, { type: "feed", value: live([first]) });
    expect(current.preview).toEqual({ name: first.name, feed: null, commentary: null });
  });
  it("shows contract prose, open command age, latest commentary and three marked files", () => {
    const data = detail(run());
    const current = preview(
      {
        ...data,
        contract: "# A heading with many words\n\nFix the hooks.\u001b\nMore prose.",
        digest: {
          ...data.digest,
          filesWritten: ["one", "two", "three", "four"],
          outsideMayChange: ["two", "four"],
        },
      },
      [
        {
          seq: 1,
          at: at(-60000),
          event: { _tag: "AgentMessage", phase: "commentary", text: "Earlier" },
        },
        {
          seq: 2,
          at: at(-20000),
          event: { _tag: "AgentMessage", phase: "commentary", text: "Testing\nmore" },
        },
        { seq: 3, at: at(), event: { _tag: "AgentMessage", phase: "final_answer", text: "Final" } },
      ],
    );
    expect(view(current).preview).toEqual({
      name: data.run.name,
      task: "Fix the hooks. ",
      now: "… bun run check · 20s",
      said: "“Testing” · 20s ago",
      files: [
        { path: "one", outside: false },
        { path: "two", outside: true },
        { path: "three", outside: false },
      ],
      moreFiles: 1,
      outsideCount: 2,
    });
  });
  it("falls back to title when prose is absent and retains row activity without detail", () => {
    expect(
      view(preview({ ...detail(run()), contract: "# Only a heading" }, [])).preview,
    ).toMatchObject({
      task: "Fix hooks",
      said: null,
      files: [{ path: "src/hooks.ts", outside: false }],
      moreFiles: 0,
      outsideCount: 0,
    });
    expect(view(state()).preview).toMatchObject({
      task: "Fix hooks",
      now: "… bun run check · 20s",
      said: null,
      files: [],
      moreFiles: 0,
      outsideCount: 0,
    });
    expect(
      view(state([run("unknown", { title: null, activity: null, outsideMayChange: null })]))
        .preview,
    ).toMatchObject({ task: null, now: null, outsideCount: null });
  });
  it("hides the preview without selection, in detail, and below thirty rows", () => {
    expect(view(state([])).preview).toBeNull();
    expect(view(reduce(state(), { type: "key", key: "enter" })).preview).toBeNull();
    expect(view(state(undefined, 100, 29)).preview).toBeNull();
    expect(view(state(undefined, 100, 30)).preview?.name).toBe("fix-hooks");
    expect(
      view(reduce(reduce(state(), { type: "key", key: "enter" }), { type: "key", key: "escape" }))
        .preview?.name,
    ).toBe("fix-hooks");
  });
  it("keeps latest commentary across empty pages and handles reconnect and archive feeds", () => {
    let current = preview();
    const name = run().name;
    current = reduce(current, { type: "preview-feed", name, value: detailLive(detail(run()), []) });
    expect(view(current).preview?.said).toBe("“event 40” · 0s ago");
    const reconnect: DetailFeed = {
      _tag: "Reconnecting",
      last: detail(run()),
      reason: "socket closed",
      retryAt: now + 1000,
    };
    current = reduce(current, { type: "preview-feed", name, value: reconnect });
    expect(view(current).preview?.task).toBe("Keep the existing hook API.");
    current = reduce(current, {
      type: "preview-feed",
      name,
      value: { _tag: "Archived", receivedAt: now },
    });
    expect(view(current).preview).toMatchObject({ task: "Fix hooks", said: null, files: [] });
  });
  it("does not animate for pinned failures or preview commentary on an inactive screen", () => {
    const current = preview(detail(run("failed", { state: "failed", subagents: [] })));
    expect(view(current).pinned).toHaveLength(1);
    expect(view(current).preview?.said).toBeTruthy();
    expect(view(current).animating).toBe(false);
  });
  it("retains commentary during reconnect and empty resumed pages, but resets for a replaced run", () => {
    const data = detail(run());
    const name = data.run.name;
    const reconnect: DetailFeed = {
      _tag: "Reconnecting",
      last: data,
      reason: "socket closed",
      retryAt: now + 1000,
    };
    let current = reduce(preview(data), { type: "preview-feed", name, value: reconnect });
    expect(current.preview?.feed).toBe(reconnect);
    expect(view(current).preview?.said).toBe("“event 40” · 0s ago");
    const resumed = detailLive(data, []);
    current = reduce(current, { type: "preview-feed", name, value: resumed });
    expect(current.preview?.feed).toBe(resumed);
    expect(view(current).preview?.said).toBe("“event 40” · 0s ago");
    const replacement = { ...data, record: { ...data.record, createdAt: at(1) } };
    current = reduce(current, { type: "preview-feed", name, value: detailLive(replacement, []) });
    expect(view(current).preview?.said).toBeNull();
  });
  it("refreshes preview ages from receipt time while an inactive saved screen is not animating", () => {
    const data = detail(run("idle", { state: "idle", activity: null }));
    let current = reduce(state([data.run]), { type: "feed", value: saved([data.run]) });
    current = reduce(current, {
      type: "preview-feed",
      name: data.run.name,
      value: {
        _tag: "Saved",
        detail: data,
        events: [
          {
            seq: 1,
            at: at(300000),
            event: { _tag: "AgentMessage", phase: "commentary", text: "Earlier update" },
          },
        ],
        gap: false,
        reason: "no-daemon",
        receivedAt: now + 600000,
        nextProbeAt: now + 610000,
      },
    });
    expect(view(current).preview?.said).toBe("“Earlier update” · 5m ago");
    expect(view(current).animating).toBe(false);
    expect(current.now).toBe(now + 600000);
  });
  it.each(["---\n", "```sh\necho example\n```\n"])(
    "skips Markdown blocks before the first contract prose: %s",
    (block) => {
      const contract = `# Task\n\n${block}\nFix the hooks.\nMore description.`;
      expect(view(preview({ ...detail(run()), contract }, [])).preview?.task).toBe(
        "Fix the hooks.",
      );
    },
  );
});
