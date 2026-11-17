import { describe, expect, it } from "vitest";
import { initialState, reduce, view } from "../src/core/monitor/model";
import type { State } from "../src/core/monitor/model-types";
import { defaults, detail, detailLive, live, now, question, run } from "./helpers/monitor";

const q = question.id;
if (!q) throw new Error("The monitor fixture needs a question.");
const waiting = run("waiting", { state: "waiting", questions: [q] });
const key = (state: State, key: string) => reduce(state, { type: "key", key });
const start = () =>
  reduce(initialState({ group: "/repo", defaults, version: "dev", now, columns: 140, rows: 40 }), {
    type: "feed",
    value: live([waiting, run("other"), run("zulu")]),
  });
const outcome = (state: State, ok = true, text = "Done") => {
  const id = state.act.inFlight?.id;
  if (id === undefined) throw new Error("Expected an in-flight action.");
  return reduce(state, { type: "act-outcome", outcome: { id, ok, text } });
};
const answer = () => outcome(key(key(start(), "a"), "y"));
const lost = (state: State) =>
  reduce(state, { type: "acting-lost", text: "The daemon connection closed; back to watching." });
const review = (pending = false) => {
  const unanswered = detail().questions.find((question) => question.status === "pending");
  if (!unanswered) throw new Error("Expected a pending fixture question.");
  const row = run("waiting", {
    state: "idle",
    questions: pending ? [{ ...q, id: unanswered.id }] : [],
  });
  let state = key(reduce(start(), { type: "feed", value: live([row]) }), "r");
  state = reduce(state, { type: "detail-feed", name: row.name, value: detailLive(detail(row)) });
  return { ...state, act: { ...state.act, mode: "acting" as const } };
};

describe("acting event ordering", () => {
  it.each(["escape", "n"])(
    "cancels an opening connection with %s and releases a late success",
    (cancel) => {
      const opening = key(key(start(), "a"), "y");
      const cancelled = key(opening, cancel);
      expect(cancelled.act.overlay).toBeNull();
      expect(cancelled.act.mode).toBe("watching");
      const finished = outcome(cancelled);
      expect(finished.act).toMatchObject({
        mode: "watching",
        overlay: null,
        inFlight: { id: 2, intent: { kind: "leave-acting" } },
      });
      expect(opening.act.inFlight?.intent).toEqual({ kind: "enter-acting", resume: "answer" });
      expect(outcome(finished).act).toMatchObject({
        mode: "watching",
        overlay: null,
        inFlight: null,
      });
      expect(outcome(cancelled, false, "Open refused").act).toMatchObject({
        mode: "watching",
        overlay: null,
        inFlight: null,
        notice: { ok: false, text: "Open refused" },
      });
    },
  );

  it("cancels the resumed answer box after the enter outcome without leaving acting", () => {
    const state = key(answer(), "escape");
    expect(state.act).toMatchObject({ mode: "acting", overlay: null, inFlight: null });
    expect(key(state, "a").act.overlay?.kind).toBe("answer");
  });

  it.each(["j", "k", "enter", "r", "y", "!", "?", "ctrl-s", "ctrl-d", "ctrl-e"])(
    "keeps normal %s routing while a direct defer is in flight",
    (shortcut) => {
      const sent = key(key(answer(), "escape"), "d");
      const sending = { ...sent, selected: waiting.name };
      const idle = { ...sending, act: { ...sending.act, inFlight: null } };
      const expected = key(idle, shortcut);
      const actual = key(sending, shortcut);
      expect(actual).toEqual({
        ...expected,
        act: { ...expected.act, inFlight: sending.act.inFlight },
      });
    },
  );

  it("blocks new actions without an overlay and mark-reviewed inside Review", () => {
    const sending = key(key(answer(), "escape"), "d");
    for (const shortcut of ["a", "d", "s", "F", "i", "x", "w"])
      expect(key(sending, shortcut)).toEqual(sending);
    const reviewing = key(review(true), "d");
    expect(key(reviewing, "r").act.inFlight).toEqual(reviewing.act.inFlight);
  });

  it.each(["a", "s", "F"])(
    "retains an open %s editor's result across connection loss",
    (action) => {
      let state = action === "a" ? answer() : key(answer(), "escape");
      if (action !== "a") {
        state = reduce(state, {
          type: "feed",
          value: live([run("waiting", { state: action === "F" ? "idle" : "running" })]),
        });
        state = key(state, action);
      }
      state = reduce(state, { type: "draft", text: "Original draft" });
      const editing = key(state, "ctrl-e");
      const id = editing.act.editor?.id;
      if (id === undefined) throw new Error("Expected an editor request.");
      const disconnected = lost(editing);
      expect(disconnected.act.overlay).toBeNull();
      expect(disconnected.act.editor).toEqual(editing.act.editor);
      expect(
        reduce(disconnected, { type: "editor-result", id: id + 1, text: "Stale", error: null }),
      ).toEqual(disconnected);
      const result = reduce(disconnected, {
        type: "editor-result",
        id,
        text: "Edited\ndraft",
        error: null,
      });
      expect(result.act.editor).toBeNull();
      const reopened = outcome(key(key(result, action), "y"));
      expect(view(reopened).act.answer?.draft ?? view(reopened).act.compose?.draft).toBe(
        "Edited\ndraft",
      );
      const failed = reduce(disconnected, {
        type: "editor-result",
        id,
        text: null,
        error: "Editor failed",
      });
      expect(failed.act.drafts).toEqual(editing.act.drafts);
      expect(failed.act.notice?.text).toBe("Editor failed");
    },
  );

  it.each([true, false])(
    "reports an unknown send outcome on loss, then shows a late outcome (ok=%s)",
    (ok) => {
      const sending = key(reduce(answer(), { type: "draft", text: "Keep it" }), "enter");
      const disconnected = lost(sending);
      expect(disconnected.act).toMatchObject({ mode: "watching", overlay: null });
      expect(disconnected.act.inFlight).toEqual(sending.act.inFlight);
      expect(view(disconnected).act.notice).toEqual({
        ok: false,
        text: "connection closed; outcome unknown · foreman status waiting",
        at: now,
      });
      const finished = outcome(disconnected, ok, ok ? "Answered waiting q2" : "Answer refused");
      expect(finished.act).toMatchObject({ mode: "watching", overlay: null, inFlight: null });
      expect(view(finished).act.notice).toEqual({
        ok,
        text: ok ? "Answered waiting q2" : "Answer refused",
        at: now,
      });
      expect(finished.act.drafts["waiting/q2"]).toBe(ok ? undefined : "Keep it");
    },
  );
});

describe("deferred Review answers", () => {
  it("stops offering defer when the open Review answer becomes deferred", () => {
    const opened = reduce(key(review(true), "a"), { type: "draft", text: "Answer in progress" });
    const row = run("waiting", { state: "idle" });
    const data = detail(row);
    const refreshed = reduce(opened, {
      type: "detail-feed",
      name: row.name,
      value: detailLive({
        ...data,
        questions: data.questions.map((question) =>
          question.id === "q1" ? { ...question, status: "deferred" } : question,
        ),
      }),
    });
    expect(key(refreshed, "ctrl-d")).toEqual(refreshed);
    expect(view(refreshed).act.hints).toEqual([
      { key: "enter", label: "send" },
      { key: "ctrl-e", label: "$EDITOR" },
      { key: "esc", label: "cancel" },
    ]);
    expect(key(refreshed, "enter").act.inFlight?.intent).toEqual({
      kind: "answer",
      name: "waiting",
      question: "q1",
      text: "Answer in progress",
    });
  });

  it.each([false, true])("does not defer an already-deferred question in acting=%s", (acting) => {
    const state = review();
    const next = key(
      { ...state, act: { ...state.act, mode: acting ? "acting" : "watching" } },
      "d",
    );
    expect(next.act.overlay).toBeNull();
    expect(next.act.inFlight).toBeNull();
    expect(view(next).act.notice?.text).toBe("Nothing is waiting for an answer.");
  });

  it("omits defer in a late-answer box while still allowing the late answer", () => {
    const state = key(review(), "a");
    expect(key(state, "ctrl-d")).toEqual(state);
    expect(view(state).act.hints).toEqual([
      { key: "enter", label: "send" },
      { key: "ctrl-e", label: "$EDITOR" },
      { key: "esc", label: "cancel" },
    ]);
    expect(state.act.overlay).toMatchObject({
      kind: "answer",
      target: { question: "q2", deferred: true },
    });
    const drafted = reduce(state, { type: "draft", text: "Late answer" });
    expect(key(drafted, "enter").act.inFlight?.intent).toEqual({
      kind: "answer",
      name: "waiting",
      question: "q2",
      text: "Late answer",
    });
  });

  it("still defers a pending question when Review also contains a deferred question", () => {
    expect(key(review(true), "d").act.inFlight?.intent).toEqual({
      kind: "defer",
      name: "waiting",
      question: "q1",
    });
    expect(key(review(true), "a").act.overlay).toMatchObject({
      kind: "answer",
      target: { deferred: false },
    });
  });
});
