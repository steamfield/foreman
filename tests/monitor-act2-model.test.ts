import { describe, expect, it } from "vitest";
import { initialState, reduce, view } from "../src/core/monitor/model";
import type { State } from "../src/core/monitor/model-types";
import type { RunView } from "../src/schemas/monitor";
import {
  at,
  defaults,
  detail,
  detailLive,
  live,
  now,
  overview,
  question,
  run,
} from "./helpers/monitor";

const actions = [
  { key: "s", action: "steer", states: ["running", "starting"] },
  { key: "F", action: "followup", states: ["idle", "failed", "interrupted"] },
  { key: "i", action: "interrupt", states: ["running", "starting", "waiting"] },
  { key: "x", action: "archive", states: ["idle", "failed", "interrupted", "lost", "unknown"] },
] as const;
const states: RunView["state"][] = [
  "running",
  "starting",
  "waiting",
  "idle",
  "failed",
  "interrupted",
  "lost",
  "unknown",
];
const key = (state: State, key: string) => reduce(state, { type: "key", key });
const draft = (state: State, text = "  Keep this.\nAnd this.  ") =>
  reduce(state, { type: "draft", text });
const start = (runs = [run()], acting = true) => {
  const state = reduce(
    initialState({ group: "/repo", defaults, version: "dev", now, columns: 140, rows: 40 }),
    { type: "feed", value: live(runs) },
  );
  return acting ? { ...state, act: { ...state.act, mode: "acting" as const } } : state;
};
const outcome = (state: State, ok = true) => {
  const id = state.act.inFlight?.id;
  if (id === undefined) throw new Error("Expected an in-flight action.");
  return reduce(state, {
    type: "act-outcome",
    outcome: { id, ok, text: ok ? "Done" : "Daemon refused" },
  });
};
const box = (action = "s") =>
  key(start([run("fix-hooks", { state: action === "F" ? "idle" : "running" })]), action);
const answer = () => {
  const q = question.id;
  if (!q) throw new Error("Missing fixture question.");
  return key(start([run("fix-hooks", { state: "waiting", questions: [q] })]), "a");
};

describe("monitor phase 2 acting model", () => {
  for (const action of actions) {
    it.each(states)(`${action.key} checks eligibility in %s`, (status) => {
      const state = key(start([run("add-retry", { state: status })]), action.key);
      if (action.states.some((allowed) => allowed === status)) {
        expect(state.act.notice).toBeNull();
        expect(state.act.overlay?.kind).toBe(
          action.key === "s" || action.key === "F" ? "compose" : `confirm-${action.action}`,
        );
      } else {
        expect(state.act.overlay).toBeNull();
        expect(state.act.inFlight).toBeNull();
        expect(view(state).act.notice).toMatchObject({
          ok: false,
          text: expect.stringContaining(`add-retry is ${status};`),
        });
      }
    });
    it(`${action.key} requires a selected run`, () => {
      const state = key(start([]), action.key);
      expect(view(state).act.notice?.text).toBe("Select a run first.");
      expect(state.act.overlay).toBeNull();
    });
    it(`${action.key} confirms watching and resumes against a fresh target`, () => {
      let state = key(start([run("old", { state: action.states[0] })], false), action.key);
      expect(state.act.overlay).toEqual({ kind: "confirm-acting", resume: action.action });
      state = key(state, "y");
      state = reduce(state, {
        type: "feed",
        value: live([run("fresh", { state: action.states[0] })]),
      });
      state = outcome(state);
      expect(state.act.mode).toBe("acting");
      expect(state.act.overlay).toMatchObject(
        action.action === "steer" || action.action === "followup"
          ? { kind: "compose", target: { name: "fresh", action: action.action } }
          : { kind: `confirm-${action.action}`, name: "fresh" },
      );
    });
    it.each(["saved", "outdated", "reconnecting"])(`${action.key} refuses a %s feed`, (kind) => {
      const state = reduce(start([run("fix-hooks", { state: action.states[0] })]), {
        type: "feed",
        value:
          kind === "reconnecting"
            ? { _tag: "Reconnecting", last: overview(), retryAt: now, reason: "closed" }
            : {
                _tag: "Saved",
                reason: kind === "outdated" ? "outdated" : "no-daemon",
                overview: { _tag: "Overview", daemon: null, runs: [run()] },
                receivedAt: now,
                nextProbeAt: now,
              },
      });
      const next = key(state, action.key);
      expect(next.act.overlay).toBeNull();
      expect(view(next).act.notice?.text).toBe(
        "Acting needs a running foreman daemon of this build; foreman status <run> starts supervision.",
      );
    });
    it(`${action.key} targets the detail run before the list selection`, () => {
      let state = key(start([run("detail", { state: action.states[0] })]), "enter");
      state = reduce(state, {
        type: "detail-feed",
        name: run("detail").name,
        value: detailLive(detail(run("detail", { state: action.states[0] }))),
      });
      state = { ...state, selected: "other" };
      const next = key(state, action.key);
      expect(next.act.overlay).toMatchObject(
        action.action === "steer" || action.action === "followup"
          ? { target: { name: "detail" } }
          : { name: "detail" },
      );
    });
  }
  it("rechecks eligibility after entering acting", () => {
    let state = key(key(start([run()], false), "s"), "y");
    state = reduce(state, { type: "feed", value: live([run("fix-hooks", { state: "idle" })]) });
    state = outcome(state);
    expect(state.act.overlay).toBeNull();
    expect(view(state).act.notice?.text).toContain("fix-hooks is idle;");
  });
  it("keeps compose metadata and draft when a refreshed feed no longer includes the run", () => {
    const state = reduce(draft(box()), { type: "feed", value: live([]) });
    expect(view(state).act.compose).toEqual({
      title: "steer fix-hooks",
      meta: "turn 2 · running 12m",
      draft: "  Keep this.\nAnd this.  ",
      sending: false,
    });
  });
  it("steers the interrupt target even if list selection changes", () => {
    let state = key(start([run("a"), run("b")]), "i");
    state = { ...state, selected: "b" };
    expect(key(state, "s").act.overlay).toMatchObject({
      kind: "compose",
      target: { name: "a", action: "steer" },
    });
  });
  it("holds the editor's box until the hand-off completes and ignores results after connection loss", () => {
    const state = key(draft(box()), "ctrl-e");
    for (const shortcut of ["escape", "enter", "F", "ctrl-e", "j"])
      expect(key(state, shortcut)).toEqual(state);
    const lost = reduce(state, { type: "acting-lost", text: "Connection closed" });
    expect(lost.act.editor).toBeNull();
    expect(lost.act.drafts["fix-hooks/steer"]).toBe("  Keep this.\nAnd this.  ");
    expect(reduce(lost, { type: "editor-result", id: 1, text: "late", error: null })).toEqual(lost);
  });
  it.each(["saved", "outdated", "reconnecting"])(
    "refuses actions from a %s detail even when the overview is live",
    (kind) => {
      const data = detail(run());
      let state = key(start(), "enter");
      state = reduce(state, {
        type: "detail-feed",
        name: data.run.name,
        value:
          kind === "reconnecting"
            ? { _tag: "Reconnecting", last: data, retryAt: now, reason: "closed" }
            : {
                _tag: "Saved",
                detail: data,
                events: [],
                gap: false,
                receivedAt: now,
                nextProbeAt: now,
                reason: kind === "outdated" ? "outdated" : "no-daemon",
              },
      });
      for (const action of actions) {
        const next = key(state, action.key);
        expect(next.act.overlay).toBeNull();
        expect(view(next).act.notice?.text).toContain("Acting needs a running foreman daemon");
      }
    },
  );
  it("can act from a live detail opened directly without a list feed", () => {
    const data = detail(run());
    let state = initialState({
      group: "/repo",
      defaults,
      version: "dev",
      now,
      columns: 140,
      rows: 40,
      name: data.run.name,
    });
    state = reduce(state, { type: "detail-feed", name: data.run.name, value: detailLive(data) });
    state = outcome(key(key(state, "s"), "y"));
    expect(view(state).act.compose?.title).toBe("steer fix-hooks");
  });
  it.each(["s", "F"])(
    "%s retains drafts on cancel, refuses blank text and ctrl-d, sends raw text and handles outcomes",
    (action) => {
      let state = draft(box(action));
      const draftKey = `fix-hooks/${action === "s" ? "steer" : "followup"}`;
      expect(key(state, "ctrl-d").act.inFlight).toBeNull();
      state = key(key(state, "escape"), action);
      expect(view(state).act.compose?.draft).toBe("  Keep this.\nAnd this.  ");
      expect(key(draft(state, " \n\t "), "enter").act.inFlight).toBeNull();
      for (const send of ["enter", "ctrl-s"]) {
        const sent = key(state, send);
        expect(sent.act.inFlight?.intent).toEqual({
          kind: action === "s" ? "steer" : "followup",
          name: "fix-hooks",
          text: "  Keep this.\nAnd this.  ",
        });
        expect(view(sent).act.compose?.sending).toBe(true);
        const failed = outcome(sent, false);
        expect(view(failed).act.compose?.draft).toBe("  Keep this.\nAnd this.  ");
        expect(view(failed).act.notice?.text).toBe("Daemon refused");
        const done = outcome(sent);
        expect(done.act.overlay).toBeNull();
        expect(done.act.drafts[draftKey]).toBeUndefined();
        expect(view(done).act.notice).toMatchObject({ ok: true, text: "Done" });
      }
    },
  );
  it.each(["n", "escape"])("cancels both destructive confirms with %s", (cancel) => {
    for (const action of ["i", "x"]) {
      const state = key(box(action === "x" ? "F" : "s"), "escape");
      const opened = key(state, action);
      expect(opened.act.overlay?.kind).toBe(
        action === "x" ? "confirm-archive" : "confirm-interrupt",
      );
      const cancelled = key(opened, cancel);
      expect(cancelled.act.overlay).toBeNull();
      expect(cancelled.act.inFlight).toBeNull();
    }
  });
  it.each(["y", "k"])("archives with %s, retaining confirmation on failure", (confirm) => {
    const state = key(key(key(box("F"), "escape"), "x"), confirm);
    expect(state.act.inFlight?.intent).toEqual({
      kind: "archive",
      name: "fix-hooks",
      keepWorktree: confirm === "k",
    });
    expect(outcome(state, false).act.overlay?.kind).toBe("confirm-archive");
    expect(outcome(state).act.overlay).toBeNull();
  });
  it("interrupts and keeps a failed confirmation", () => {
    const state = key(key(start(), "i"), "y");
    expect(state.act.inFlight?.intent).toEqual({ kind: "interrupt", name: "fix-hooks" });
    expect(outcome(state, false).act.overlay?.kind).toBe("confirm-interrupt");
    expect(outcome(state).act.overlay).toBeNull();
  });
  it.each(["running", "starting", "waiting"] as const)(
    "offers steer instead only for a steerable %s run",
    (status) => {
      const state = key(start([run("fix-hooks", { state: status })]), "i");
      expect(view(state).act.confirm?.keys).toEqual([
        { key: "y", label: "interrupt" },
        ...(status === "waiting" ? [] : [{ key: "s", label: "steer instead" }]),
        { key: "n", label: "cancel" },
      ]);
      expect(key(state, "s").act.overlay?.kind).toBe(
        status === "waiting" ? "confirm-interrupt" : "compose",
      );
    },
  );
  it.each(["answer", "steer", "followup"])(
    "hands the %s draft to the editor once and replaces it on a matching result",
    (kind) => {
      let state = draft(kind === "answer" ? answer() : box(kind === "steer" ? "s" : "F"));
      const draftKey = `fix-hooks/${kind === "answer" ? "q2" : kind}`;
      const id = state.act.nextId;
      state = key(state, "ctrl-e");
      expect(state.act.editor).toEqual({ id, text: "  Keep this.\nAnd this.  " });
      expect(state.act.nextId).toBe(id + 1);
      expect(key(state, "ctrl-e").act.editor).toEqual(state.act.editor);
      expect(
        reduce(state, { type: "editor-result", id: id + 1, text: "wrong", error: null }),
      ).toEqual(state);
      state = reduce(state, { type: "editor-result", id, text: "Edited\ntext", error: null });
      expect(state.act.editor).toBeNull();
      expect(state.act.drafts[draftKey]).toBe("Edited\ntext");
      expect(view(state).act.answer?.draft ?? view(state).act.compose?.draft).toBe("Edited\ntext");
    },
  );
  it.each([null, "Editor could not start"])(
    "keeps editor drafts on a null result (error=%s)",
    (error) => {
      let state = key(draft(box()), "ctrl-e");
      state = reduce(state, { type: "editor-result", id: 1, text: null, error });
      expect(state.act.editor).toBeNull();
      expect(view(state).act.compose?.draft).toBe("  Keep this.\nAnd this.  ");
      expect(view(state).act.notice).toEqual(error ? { ok: false, text: error, at: now } : null);
    },
  );
  it.each(["s", "F", "i", "x"])("swallows unrelated keys in the %s overlay", (action) => {
    const state = key(
      start([run("fix-hooks", { state: action === "F" || action === "x" ? "idle" : "running" })]),
      action,
    );
    for (const unrelated of ["j", "q", "a", "d", "F", "i", "x", "w", "tab", "?"])
      expect(key(state, unrelated)).toEqual(state);
  });
  it.each(["s", "F", "i", "x"])("ignores all action keys while %s is in flight", (action) => {
    const opened = key(
      start([run("fix-hooks", { state: action === "F" || action === "x" ? "idle" : "running" })]),
      action,
    );
    const state = key(draft(opened), action === "s" || action === "F" ? "enter" : "y");
    for (const blocked of [
      "a",
      "d",
      "s",
      "F",
      "i",
      "x",
      "w",
      "y",
      "k",
      "enter",
      "ctrl-s",
      "ctrl-d",
      "ctrl-e",
    ])
      expect(key(state, blocked)).toEqual(state);
  });
  it.each(["s", "F"])("shows compose metadata and editor hints for %s", (action) => {
    expect(view(draft(box(action))).act.compose).toEqual({
      title: `${action === "s" ? "steer" : "follow up"} fix-hooks`,
      meta: `turn 2 · ${action === "s" ? "running" : "idle"} 12m`,
      draft: "  Keep this.\nAnd this.  ",
      sending: false,
    });
    expect(view(box(action)).act.hints).toEqual([
      { key: "enter", label: "send" },
      { key: "ctrl-e", label: "$EDITOR" },
      { key: "esc", label: "cancel" },
    ]);
    expect(view(answer()).act.hints).toContainEqual({ key: "ctrl-e", label: "$EDITOR" });
  });
  it("shows interrupt facts from the row and matching detail, omitting unavailable facts", () => {
    const row = run("fix-hooks", { outsideMayChange: 2 });
    let state = key(start([row]), "enter");
    state = reduce(state, { type: "detail-feed", name: row.name, value: detailLive(detail(row)) });
    const confirm = view(key(state, "i")).act.confirm;
    expect(confirm?.title).toBe("Interrupt fix-hooks?");
    expect(confirm?.lines).toEqual([
      "Stops turn 2 now. Codex writes a hand-off; the worktree and branch stay.",
      "The open command bun run check · running 20s, will be killed",
      "used 12m of 1h00m · 12 commands",
      "2 files outside scope",
      "The session that started this run will see it as interrupted from foreman monitor.",
    ]);
    expect(view(key(start([row]), "i")).act.confirm?.lines).toContain("used 12m of 1h00m");
    const bare = view(
      key(
        start([run("fix-hooks", { activity: null, turnBudgetMs: null, outsideMayChange: 0 })]),
        "i",
      ),
    ).act.confirm;
    expect(bare?.lines).toHaveLength(2);
  });
  it("names archive worktree and branch and exposes confirm keys as hints", () => {
    const confirm = view(key(start([run("fix-hooks", { state: "idle" })]), "x")).act;
    expect(confirm.confirm).toEqual({
      title: "Archive fix-hooks?",
      lines: [
        "worktree /repo/work",
        "branch work",
        "Removes the worktree and branch; the run record moves to the archive. Uncommitted changes in the worktree are lost.",
      ],
      keys: [
        { key: "y", label: "archive" },
        { key: "k", label: "keep worktree" },
        { key: "n", label: "cancel" },
      ],
    });
    expect(confirm.hints).toEqual(confirm.confirm?.keys);
  });
  it("shows acting confirm keys without the old inline legend", () => {
    const model = view(key(start([run()], false), "s")).act;
    expect(model.confirm?.keys).toEqual([
      { key: "y", label: "confirm" },
      { key: "n", label: "cancel" },
    ]);
    expect(model.confirm?.lines).not.toContain("y confirm  n cancel");
  });
  it.each(["answered", "deferred", "late"] as const)(
    "attributes %s questions and interruptions to the monitor",
    (resolution) => {
      const row = run();
      const q = question.id;
      if (!q) throw new Error("Missing fixture question.");
      let state = key(start([row]), "enter");
      state = reduce(state, {
        type: "detail-feed",
        name: row.name,
        value: detailLive(detail(row), [
          {
            seq: 1,
            at: at(),
            event: { _tag: "QuestionResolved", id: q.id, resolution, source: "monitor" },
          },
          { seq: 2, at: at(), event: { _tag: "Interrupted", by: "monitor" } },
        ]),
      });
      const panes = view(state).detail?.panes;
      const expected = `q2 ${resolution} from monitor`;
      expect(panes?.find((p) => p.id === "feed")?.lines.map((l) => l.text)).toEqual([
        expected,
        "interrupted from monitor",
      ]);
      expect(panes?.find((p) => p.id === "questions")?.lines.map((l) => l.text)).toContain(
        expected,
      );
    },
  );
});
