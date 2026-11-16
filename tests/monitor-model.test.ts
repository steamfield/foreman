import { describe, expect, it } from "vitest";
import { initialState, OLDER_IDLE_MS, reduce, view } from "../src/core/monitor/model";
import { at, defaults, live, mixedRuns, now, overview, run, subagents } from "./helpers/monitor";

const state = (runs = mixedRuns(), columns = 140, rows = 40) =>
  reduce(initialState({ group: "/repo", defaults, version: "0.1.3", now, columns, rows }), {
    type: "feed",
    value: live(runs),
  });
describe("monitor list model", () => {
  it("returns to the attention notes with Home after navigating a tall first run", () => {
    const questions = mixedRuns()[0]?.questions ?? [];
    const current = state(
      [
        run("first", {
          state: "waiting",
          lastActivityAt: at(),
          questions,
          subagents: subagents(10),
        }),
        run("second", { questions }),
        run("third", { questions }),
      ],
      100,
      24,
    );
    expect(view(reduce(current, { type: "key", key: "home" })).offset).toBe(0);
  });
  it("moves selection to the older-idle entry when a tick collapses the selected run", () => {
    const current = state([
      run("aging", { state: "idle", lastActivityAt: at(), stateSince: at(-OLDER_IDLE_MS + 500) }),
      run("active"),
    ]);
    expect(view(current).selected).toBe("aging");
    const next = reduce(current, { type: "tick", now: now + 1000 });
    expect(view(next).selected).toBe("older:/repo");
    expect(
      view(reduce(next, { type: "key", key: "enter" })).groups[0]?.rows.map((row) => row.name),
    ).toContain("aging");
  });
  it("keeps the selected run visible when new activity moves it below a screenful", () => {
    const current = state([run("selected")], 100, 12);
    const next = reduce(current, {
      type: "feed",
      value: live([
        ...Array.from({ length: 20 }, (_, i) => run(`new-${i}`, { lastActivityAt: at() })),
        run("selected"),
      ]),
    });
    expect(view(next).selected).toBe("selected");
    expect(view(next).offset).toBeGreaterThan(0);
  });
  it("keeps selection by run name through updates, then chooses its nearest neighbour", () => {
    let current = reduce(state([run("a"), run("b"), run("c")]), { type: "key", key: "j" });
    expect(view(current).selected).toBe("b");
    current = reduce(current, { type: "feed", value: live([run("c"), run("b"), run("a")]) });
    expect(view(current).selected).toBe("b");
    current = reduce(current, { type: "feed", value: live([run("a"), run("c")]) });
    expect(view(current).selected).toBe("c");
  });
  it("orders cwd first and groups and runs by recent activity", () => {
    const model = view(
      state([
        run("old", { group: "/z", lastActivityAt: at(-60000) }),
        run("new", { group: "/a", lastActivityAt: at() }),
        run("own", { lastActivityAt: at(-120000) }),
      ]),
    );
    expect(model.groups.map((group) => group.id)).toEqual(["/repo", "/a", "/z"]);
  });
  it("collapses older idle runs, expands on Enter, and filters attention", () => {
    let current = state();
    expect(view(current).groups[0]?.older?.text).toBe("· 1 idle run older than 24h");
    current = reduce(current, { type: "key", key: "end" });
    current = reduce(current, { type: "key", key: "k" });
    current = reduce(current, { type: "key", key: "enter" });
    expect(view(current).groups[0]?.rows.some((row) => row.name === "older")).toBe(true);
    current = reduce(current, { type: "key", key: "a" });
    expect(view(current).groups.flatMap((group) => group.rows.map((row) => row.name))).toEqual([
      "fix-hooks",
      "parser",
      "other",
    ]);
  });
  it("reports pending, deferred, quiet, retries, hooks, scope and settings flags", () => {
    const model = view(state());
    expect(
      model.groups[0]?.rows.find((row) => row.name === "parser")?.flags.map((flag) => flag.text),
    ).toEqual([
      "2 deferred",
      "quiet 6m",
      "retrying (usage limit)",
      "3 hooks blocked",
      "2 outside scope",
      "effort medium",
      "read-only",
    ]);
    expect(model.notes[0]?.command).toBe("foreman answer fix-hooks q2 --file <path>");
    expect(model.notes[1]?.command).toBe("other repo: its own session supervises it");
  });
  it.each([
    [79, "running"],
    [80, "interrupted"],
    [100, "failed"],
  ])("colors a budget at %i percent as %s", (percent, tone) => {
    const model = view(
      state([run("budget", { turnStartedAt: at(-percent * 60000), turnBudgetMs: 6000000 })]),
    );
    expect(model.groups[0]?.rows[0]?.budget?.tone).toBe(tone);
    expect(view(state([run("idle", { state: "idle" })])).groups[0]?.rows[0]?.budget).toBeNull();
  });
  it.each([
    [70, "narrow", 0],
    [100, "medium", 6],
    [140, "wide", 10],
  ])("uses the %i-column breakpoint", (columns, layout, cells) => {
    const model = view(state(undefined, columns, 23));
    expect(model.layout).toBe(layout);
    expect(model.budgetCells).toBe(cells);
    expect(model.notes).toHaveLength(1);
    expect(model.footer.compact).toBe(true);
  });
  it("stops animation on an idle screen and Enter opens the selected run", () => {
    const idle = state([run("idle", { state: "idle", subagents: [] })]);
    expect(view(idle).animating).toBe(false);
    expect(view(reduce(idle, { type: "key", key: "enter" })).detail?.name).toBe("idle");
    expect(view(state()).animating).toBe(true);
    const current = state();
    expect(reduce(current, { type: "tick", now: now + 100 })).toBe(current);
  });
  it("keeps unchanged row identities across selection, ticks and equal feed values", () => {
    const current = state([run("idle", { state: "idle", activity: null })]);
    const before = view(current);
    const after = view(
      reduce(current, {
        type: "feed",
        value: live([run("idle", { state: "idle", activity: null })]),
      }),
      before,
    );
    expect(after.groups[0]?.rows[0]).toBe(before.groups[0]?.rows[0]);
  });
  it("counts only visible animation and keeps the selected run in the viewport", () => {
    const runs = [
      ...Array.from({ length: 12 }, (_, i) =>
        run(`idle-${String(i).padStart(2, "0")}`, { state: "idle" }),
      ),
      run("working"),
    ];
    const current = state(runs, 100, 12);
    expect(view(current).animating).toBe(false);
    const moved = view(reduce(current, { type: "key", key: "end" }));
    expect(moved.animating).toBe(true);
    expect(moved.selected).toBe("working");
  });
  it("does not mark a running open command quiet and limits notes on a short terminal", () => {
    expect(view(state([run("command", { quiet: true })])).groups[0]?.rows[0]?.flags).toEqual([]);
    const many = Array.from({ length: 5 }, (_, i) =>
      run(`waiting-${i}`, { state: "waiting", questions: mixedRuns()[0]?.questions ?? [] }),
    );
    expect(view(state(many)).moreNotes).toBe(2);
    expect(view(state(many, 70, 23)).moreNotes).toBe(4);
  });
  it("refreshes idle ages from feed receipt time when the animation clock is stopped", () => {
    const current = state([run("idle", { state: "idle", activity: null })]);
    const next = reduce(current, {
      type: "feed",
      value: {
        receivedAt: now + 60000,
        _tag: "Live",
        overview: overview([run("idle", { state: "idle", activity: null })]),
      },
    });
    expect(view(next).groups[0]?.rows[0]?.age).toBe("  13m");
  });
  it("reduces narrow flags to the most urgent one", () => {
    expect(
      view(state(undefined, 70)).groups[0]?.rows.find((row) => row.name === "parser")?.flags,
    ).toEqual([{ text: "3 hooks blocked", tone: "failed" }]);
  });
  it("treats settings, repository names and subagent metadata as terminal text", () => {
    const entry = run("metadata", {
      model: "model\u001b[2J",
      repo: "/repo\u001b[2J",
      subagents: [
        {
          threadId: "child",
          path: "/root/child\u001b[2J",
          model: "model\u001b[2J",
          effort: "high\u001b[2J",
          state: "idle",
          startedAt: at(),
          lastInteractionAt: at(),
          interactions: 1,
        },
      ],
    });
    const model = view(state([entry]));
    const group = model.groups[0];
    const row = group?.rows[0];
    for (const text of [
      group?.title,
      row?.flags[0]?.text,
      row?.subagents[0]?.path,
      row?.subagents[0]?.text,
    ])
      expect(text).not.toContain("\u001b");
  });
  it("keeps long state ages inside the five-column duration field", () => {
    expect(
      view(state([run("long-running", { stateSince: at(-15 * 3600000) })])).groups[0]?.rows[0]?.age,
    ).toHaveLength(5);
  });
});
