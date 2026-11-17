import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { clockTime } from "../src/core/monitor/format";
import { initialState, reduce, view } from "../src/core/monitor/model";
import type { State } from "../src/core/monitor/model-types";
import { QuestionId } from "../src/schemas/daemon";
import { at, defaults, live, now, overview, question, run } from "./helpers/monitor";

const q = question.id;
if (!q) throw new Error("The monitor fixture needs a question.");
const waiting = run("waiting", { state: "waiting", questions: [q] });
const start = (runs = [waiting]) =>
  reduce(
    initialState({
      group: "/repo",
      defaults,
      version: "0.2.0",
      now,
      columns: 140,
      rows: 40,
    }),
    { type: "feed", value: live(runs) },
  );
const key = (state: State, value: string) => reduce(state, { type: "key", key: value });
const outcome = (state: State, ok = true, text = "Done") => {
  const id = state.act.inFlight?.id;
  if (id === undefined) throw new Error("Expected an action to be in flight.");
  return reduce(state, { type: "act-outcome", outcome: { id, ok, text } });
};
const answer = () => outcome(key(key(start(), "a"), "y"));
const draft = (state: State, text = "  Keep it.\nYes.  ") => reduce(state, { type: "draft", text });

describe("monitor acting model", () => {
  it.each(["a", "d"])(
    "targets the selected waiting run or the first attention note with %s",
    (action) => {
      const runs = [
        run("other", { group: "/other", state: "waiting", questions: [q] }),
        waiting,
        run("selected", {
          state: "waiting",
          questions: [{ ...q, id: Schema.decodeUnknownSync(QuestionId)("q3") }],
        }),
      ];
      let state = key(start(runs), "j");
      expect(state.selected).toBe("waiting");
      state = key(state, "k");
      expect(state.selected).toBe("selected");
      state = outcome(key(key(state, action), "y"));
      expect(action === "a" ? view(state).act.answer?.title : state.act.inFlight?.intent).toEqual(
        action === "a" ? "selected q3" : { kind: "defer", name: "selected", question: "q3" },
      );
      const fallback = start([run("active", { lastActivityAt: at() }), ...runs]);
      expect(view(fallback).notes[0]?.id).toBe("selected:q3");
      const resumed = outcome(key(key(fallback, action), "enter"));
      expect(
        action === "a" ? view(resumed).act.answer?.title : resumed.act.inFlight?.intent,
      ).toEqual(
        action === "a" ? "selected q3" : { kind: "defer", name: "selected", question: "q3" },
      );
    },
  );
  it.each(["a", "d"])("targets only the detail run with %s", (action) => {
    const detail = key(start(), "enter");
    const resumed = outcome(key(key(detail, action), "y"));
    expect(action === "a" ? view(resumed).act.answer?.title : resumed.act.inFlight?.intent).toEqual(
      action === "a" ? "waiting q2" : { kind: "defer", name: "waiting", question: "q2" },
    );
    const activeDetail = key(start([run("active", { lastActivityAt: at() }), waiting]), "enter");
    expect(view(key(activeDetail, action)).act.notice?.text).toBe(
      "Nothing is waiting for an answer.",
    );
  });
  it.each(["a", "d"])(
    "shows a notice without an overlay when nothing is pending (%s)",
    (action) => {
      const state = key(start([run()]), action);
      expect(state.act.overlay).toBeNull();
      expect(state.act.inFlight).toBeNull();
      expect(view(state).act.notice).toEqual({
        ok: false,
        text: "Nothing is waiting for an answer.",
        at: now,
      });
    },
  );
  it.each(["saved", "outdated", "reconnecting", "probing"])(
    "refuses actions on a %s feed",
    (kind) => {
      let state = start();
      if (kind === "probing") state = { ...state, feed: null };
      else
        state = reduce(state, {
          type: "feed",
          value:
            kind === "reconnecting"
              ? {
                  _tag: "Reconnecting",
                  last: overview([waiting]),
                  retryAt: now + 1000,
                  reason: "closed",
                }
              : {
                  _tag: "Saved",
                  reason: kind === "outdated" ? "outdated" : "no-daemon",
                  overview: { _tag: "Overview", daemon: null, runs: [waiting] },
                  receivedAt: now,
                  nextProbeAt: now + 1000,
                },
        });
      for (const action of ["a", "d"]) {
        const next = key(state, action);
        expect(next.act.overlay).toBeNull();
        expect(next.act.inFlight).toBeNull();
        expect(view(next).act.notice?.text).toBe(
          "Acting needs a running foreman daemon of this build; foreman status <run> starts supervision.",
        );
      }
    },
  );
  it.each(["y", "enter"])(
    "confirms entering acting with %s and looks up the target again",
    (confirm) => {
      let state = key(start(), "a");
      expect(state.act.overlay).toEqual({ kind: "confirm-acting", resume: "answer" });
      state = key(state, confirm);
      expect(state.act.inFlight).toEqual({ id: 1, intent: { kind: "enter-acting" } });
      state = reduce(state, {
        type: "feed",
        value: live([run("fresh", { state: "waiting", questions: [q] })]),
      });
      state = outcome(state);
      expect(view(state).act.chip).toEqual({ mode: "acting", text: "◆ acting" });
      expect(view(state).act.answer?.title).toBe("fresh q2");
      expect(state.act.inFlight).toBeNull();
    },
  );
  it.each(["n", "escape"])("cancels confirmation with %s", (cancel) => {
    const opened = key(start(), "a");
    expect(view(opened).act.confirm?.title).toBe("Switch to acting?");
    const state = key(opened, cancel);
    expect(state.act).toMatchObject({ mode: "watching", overlay: null, inFlight: null });
  });
  it("shows an enter-acting failure and stays watching", () => {
    const state = outcome(key(key(start(), "d"), "y"), false, "Daemon refused");
    expect(state.act).toMatchObject({ mode: "watching", overlay: null, inFlight: null });
    expect(view(state).act.notice).toEqual({ ok: false, text: "Daemon refused", at: now });
  });
  it("restores a cancelled draft and preserves drafts across feed refreshes", () => {
    let state = key(draft(answer()), "escape");
    expect(state.act.drafts["waiting/q2"]).toBe("  Keep it.\nYes.  ");
    expect(view(state).act.answer).toBeNull();
    state = reduce(state, { type: "feed", value: live([waiting]) });
    expect(view(key(state, "a")).act.answer?.draft).toBe("  Keep it.\nYes.  ");
  });
  it.each(["enter", "ctrl-s"])("sends untrimmed text with %s but refuses whitespace", (send) => {
    expect(key(draft(answer(), " \n\t "), send).act.inFlight).toBeNull();
    const state = key(draft(answer()), send);
    expect(state.act.inFlight).toEqual({
      id: 2,
      intent: {
        kind: "answer",
        name: "waiting",
        question: "q2",
        text: "  Keep it.\nYes.  ",
      },
    });
    expect(view(state).act.answer?.sending).toBe(true);
  });
  it.each([true, false])(
    "handles an answer outcome (ok=%s) without losing a failed draft",
    (ok) => {
      const state = outcome(
        key(draft(answer()), "enter"),
        ok,
        ok ? "Answered waiting q2" : "Already resolved",
      );
      expect(state.act.inFlight).toBeNull();
      expect(view(state).act.notice).toEqual({
        ok,
        text: ok ? "Answered waiting q2" : "Already resolved",
        at: now,
      });
      expect(view(state).act.answer?.draft ?? null).toBe(ok ? null : "  Keep it.\nYes.  ");
      expect(state.act.drafts["waiting/q2"]).toBe(ok ? undefined : "  Keep it.\nYes.  ");
    },
  );
  it("defers the answer box target with ctrl-d and handles success and failure", () => {
    const state = key(draft(answer()), "ctrl-d");
    expect(state.act.inFlight?.intent).toEqual({ kind: "defer", name: "waiting", question: "q2" });
    expect(view(state).act.answer?.sending).toBe(false);
    expect(view(outcome(state)).act.answer).toBeNull();
    expect(outcome(state).act.drafts["waiting/q2"]).toBeUndefined();
    expect(view(outcome(state, false, "Offline")).act.answer?.draft).toBe("  Keep it.\nYes.  ");
  });
  it("defers directly in acting mode with increasing request ids", () => {
    const state = key(key(answer(), "escape"), "d");
    expect(state.act.overlay).toBeNull();
    expect(state.act.inFlight).toEqual({
      id: 2,
      intent: { kind: "defer", name: "waiting", question: "q2" },
    });
    expect(view(outcome(state, false, "Offline")).act.notice?.text).toBe("Offline");
  });
  it.each(["confirm", "answer"])("swallows unrelated keys in the %s overlay", (box) => {
    const state = box === "answer" ? key(answer(), "j") : key(start(), "a");
    for (const pressed of ["q", "j", "?", "!", "w", "d", "a", "tab"])
      expect(key(state, pressed)).toBe(state);
  });
  it("ignores action keys in flight, allows escape, and rejects mismatched outcomes", () => {
    for (const state of [
      key(key(start(), "a"), "y"),
      key(draft(answer()), "enter"),
      key(key(answer(), "escape"), "d"),
    ]) {
      for (const pressed of ["a", "d", "w", "y", "enter", "ctrl-s", "ctrl-d"])
        expect(key(state, pressed)).toBe(state);
      expect(
        reduce(state, { type: "act-outcome", outcome: { id: 999, ok: true, text: "Stale" } }),
      ).toBe(state);
      const escaped = key(state, "escape");
      expect(escaped.act.overlay).toBeNull();
      expect(escaped.act.inFlight).toEqual(state.act.inFlight);
      expect(outcome(escaped).act.inFlight).toBeNull();
    }
  });
  it("leaves acting immediately with w and confirms every return to acting", () => {
    let state = key(key(answer(), "escape"), "w");
    expect(state.act).toMatchObject({
      mode: "watching",
      inFlight: { id: 2, intent: { kind: "leave-acting" } },
    });
    state = key(outcome(state), "a");
    expect(state.act.overlay).toEqual({ kind: "confirm-acting", resume: "answer" });
  });
  it.each(["confirm", "answer"])(
    "drops to watching on acting-lost from %s and keeps drafts",
    (box) => {
      const before = box === "answer" ? key(draft(answer()), "enter") : key(key(start(), "a"), "y");
      const state = reduce(before, { type: "acting-lost", text: "Socket closed" });
      expect(state.act).toMatchObject({
        mode: "watching",
        overlay: null,
        inFlight: null,
        notice: { ok: false, text: "Socket closed" },
      });
      expect(state.act.drafts).toEqual(before.act.drafts);
      expect(key(state, "d").act.overlay).toEqual({ kind: "confirm-acting", resume: "defer" });
    },
  );
  it.each(["enter", "ctrl-s"])(
    "marks a resolved question and refuses %s after a feed refresh",
    (send) => {
      const state = reduce(draft(answer()), {
        type: "feed",
        value: live([run("waiting", { state: "idle" })]),
      });
      expect(view(state).act.answer).toMatchObject({ resolved: true, draft: "  Keep it.\nYes.  " });
      expect(key(state, send).act.inFlight).toBeNull();
    },
  );
  it("clears notices on the next key, while drafts and ticks keep them", () => {
    const state = outcome(key(draft(answer()), "enter"), false, "Retry");
    expect(view(draft(state, "New draft")).act.notice?.text).toBe("Retry");
    expect(view(reduce(state, { type: "tick", now: now + 1000 })).act.notice?.text).toBe("Retry");
    expect(view(key(state, "j")).act.notice).toBeNull();
    expect(key(key(start([run()]), "a"), "!").attentionOnly).toBe(true);
    expect(view(key(key(start([run()]), "a"), "!")).act.notice).toBeNull();
  });
  it("moves the attention-only toggle to !", () => {
    const state = key(start(), "!");
    expect(view(state).footer.attentionOnly).toBe(true);
    expect(view(key(state, "!")).footer.attentionOnly).toBe(false);
    expect(key(start(), "a").attentionOnly).toBe(false);
  });
  it("renders mode, confirmation, full safe text, metadata and contextual hints", () => {
    expect(view(start()).act).toEqual({
      chip: { mode: "watching", text: "◇ watching" },
      confirm: null,
      compose: null,
      answer: null,
      notice: null,
      hints: null,
    });
    const confirm = view(key(start(), "a")).act;
    expect(confirm.confirm?.title).toBe("Switch to acting?");
    expect(confirm.confirm?.lines.join(" ")).toMatch(/keeps the daemon running.*monitor is open/);
    expect(confirm.confirm?.lines.join(" ")).toContain("w");
    expect(confirm.confirm?.keys).toEqual(confirm.hints);
    expect(confirm.hints).toEqual([
      { key: "y", label: "confirm" },
      { key: "n", label: "cancel" },
    ]);
    const state = outcome(
      key(
        key(
          start([
            run("waiting", {
              state: "waiting",
              questions: [{ ...q, text: "First\u0007\tline\nSecond line" }],
            }),
          ]),
          "a",
        ),
        "y",
      ),
    );
    expect(view(state).act.answer).toEqual({
      context: [],
      title: "waiting q2",
      meta: `question · asked ${clockTime(q.askedAt)} · waited 3m · defers in 12m`,
      question: "First  line\nSecond line",
      draft: "",
      sending: false,
      resolved: false,
      alsoWaiting:
        "The delegating agent may answer too. First answer wins; the other side sees q2 resolved.",
    });
    expect(view(state).act.hints).toEqual([
      { key: "enter", label: "send" },
      { key: "ctrl-d", label: "defer" },
      { key: "ctrl-e", label: "$EDITOR" },
      { key: "esc", label: "cancel" },
    ]);
    const noDeadline = outcome(
      key(key(start([run("waiting", { questions: [{ ...q, defersAt: null }] })]), "a"), "y"),
    );
    expect(view(noDeadline).act.answer?.meta).toBe(
      `question · asked ${clockTime(q.askedAt)} · waited 3m`,
    );
  });
  it("keeps the rest of the view and animation unchanged by acting overlays", () => {
    const state = start([run("waiting", { state: "idle", questions: [q] })]);
    const { act: _before, ...before } = view(state);
    const { act: _after, ...after } = view(key(state, "a"));
    expect(after).toEqual(before);
    expect(after.animating).toBe(true);
    const resolved = reduce(answer(), {
      type: "feed",
      value: live([run("waiting", { state: "idle" })]),
    });
    expect(view(resolved).act.answer?.resolved).toBe(true);
    expect(view(resolved).animating).toBe(false);
    const idle = start([run("idle", { state: "idle" })]);
    expect(view(key(idle, "a")).animating).toBe(false);
  });
});
