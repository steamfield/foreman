import { describe, expect, it } from "vitest";
import { initialState, reduce, view } from "../src/core/monitor/model";
import {
  at,
  defaults,
  detail,
  detailEvents,
  detailLive,
  inspectStart,
  monitorKey as key,
  live,
  now,
  question,
  run,
} from "./helpers/monitor";

const finished = (state: "idle" | "failed" | "interrupted" = "idle") =>
  detail(run("done", { state, filesWritten: 2 }));
function review() {
  const events = [
    {
      seq: 1,
      at: at(-600000),
      event: { _tag: "TurnCompleted", turn: 1, status: "completed", failure: null },
    } as const,
    ...detailEvents().map((entry) => ({ ...entry, seq: entry.seq + 1 })),
  ];
  let state = key(inspectStart(finished(), events), "r");
  state = reduce(state, {
    type: "changes-result",
    id: state.detail?.changes?.id ?? -1,
    files: [
      { path: "a.ts", status: "modified", added: 1, removed: 2, outside: false },
      { path: "b.ts", status: "added", added: 3, removed: 0, outside: true },
    ],
    error: null,
  });
  return state;
}

describe("finished run review", () => {
  it.each([
    [140, 26],
    [100, 21],
  ])("pages by the inline diff's visible rows at %i columns", (columns, page) => {
    let state = reduce(review(), { type: "resize", columns, rows: 40 });
    state = key(key(key(state, "tab"), "tab"), "tab");
    const id = state.detail?.diff?.id;
    if (id === undefined) throw new Error("Expected diff request");
    state = reduce(state, {
      type: "diff-result",
      id,
      error: null,
      text: {
        text: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
        truncated: false,
      },
    });
    const next = key(state, "page-down");
    expect(view(next).diff?.offset).toBe(page);
    expect(view(key(next, "page-up")).diff?.offset).toBe(0);
  });
  it("focuses the review diff opened from Files and restores Files on Escape", () => {
    const files = key(key(review(), "tab"), "tab");
    expect(view(files).review?.focus).toBe("files");
    let opened = key(files, "d");
    expect(view(opened).review?.focus).toBe("diff");
    const id = opened.detail?.diff?.id;
    if (id === undefined) throw new Error("Expected diff request");
    opened = reduce(opened, {
      type: "diff-result",
      id,
      error: null,
      text: { text: "first\nsecond", truncated: false },
    });
    const moved = key(opened, "j");
    expect(view(moved).diff?.offset).toBe(1);
    expect(moved.detail?.changes?.selected).toBe(0);
    const closed = key(moved, "escape");
    expect(view(closed).diff).toBeNull();
    expect(view(closed).review?.focus).toBe("files");
  });
  it("answers deferred questions from review and its diff, with acting confirmation", () => {
    for (const diff of [false, true]) {
      let state = review();
      if (diff) state = key(key(key(state, "tab"), "tab"), "tab");
      state = key(state, "a");
      expect(state.act.overlay).toEqual({ kind: "confirm-acting", resume: "answer" });
      state = key(state, "y");
      state = reduce(state, {
        type: "act-outcome",
        outcome: { id: state.act.inFlight?.id ?? -1, ok: true, text: "acting" },
      });
      expect(view(state).act.answer).toMatchObject({
        title: "done q2",
        question: "Question 2: keep the API?",
        resolved: false,
      });
      state = reduce(state, { type: "draft", text: "Keep the API." });
      state = key(state, "enter");
      expect(state.act.inFlight?.intent).toEqual({
        kind: "answer",
        name: state.detail?.name,
        question: "q2",
        text: "Keep the API.",
      });
    }
  });
  it("refuses a late answer resolved while typing and keeps its draft", () => {
    let state = review();
    state = { ...state, act: { ...state.act, mode: "acting" } };
    state = key(state, "a");
    state = reduce(state, { type: "draft", text: "Keep it." });
    const data = finished();
    state = reduce(state, {
      type: "detail-feed",
      name: data.run.name,
      value: detailLive(
        { ...data, questions: data.questions.map((q) => ({ ...q, status: "resolved" })) },
        [],
      ),
    });
    expect(view(state).act.answer).toMatchObject({ resolved: true, draft: "Keep it." });
    expect(key(state, "enter").act.inFlight).toBeNull();
  });
  it("timestamps a retained hand-off from its completed turn instead of a later save", () => {
    const state = review();
    const title = view(state).review?.handoff?.title;
    expect(title).toBe("Hand-off · turn 1 · 11:50:00");
    const data = finished();
    const savedLater = reduce(state, {
      type: "detail-feed",
      name: data.run.name,
      value: detailLive({ ...data, record: { ...data.record, updatedAt: at(3600000) } }, []),
    });
    expect(view(savedLater).review?.handoff?.title).toBe(title);
  });
  it("does not invent a time for an earlier hand-off outside the event buffer", () => {
    const state = key(inspectStart(finished(), []), "r");
    expect(view(state).review?.handoff?.title).toBe("Hand-off · turn 1 · time unavailable");
  });
  it("keeps mark reviewed, follow-up and archive available in the review diff pane", () => {
    let state = review();
    state = key(key(key(state, "tab"), "tab"), "tab");
    const acting = { ...state, act: { ...state.act, mode: "acting" as const } };
    expect(key(acting, "r").act.inFlight?.intent).toEqual({
      kind: "review",
      name: state.detail?.name,
    });
    expect(key(acting, "F").act.overlay?.kind).toBe("compose");
    expect(key(acting, "x").act.overlay?.kind).toBe("confirm-archive");
  });
  it.each(["idle", "failed", "interrupted"] as const)(
    "opens review for %s from list and detail, requesting changes",
    (status) => {
      const data = finished(status);
      const list = reduce(
        initialState({ group: "/repo", defaults, version: "dev", now, columns: 100, rows: 40 }),
        { type: "feed", value: live([data.run]) },
      );
      const opened = key(list, "r");
      expect(opened.detail).toMatchObject({ review: true, changes: { id: 1, files: null } });
      const detailed = key(inspectStart(data), "r");
      expect(detailed.detail).toMatchObject({ review: true, changes: { id: 2, files: null } });
      expect(view(key(detailed, "escape")).review).toBeNull();
      expect(key(detailed, "escape").detail).toBeNull();
    },
  );
  it.each(["starting", "running", "waiting"] as const)("does not review a %s run", (state) => {
    expect(key(inspectStart(detail(run("active", { state }))), "r").detail?.review).toBe(false);
  });
  it("builds summary, hand-off, files and scope note", () => {
    const model = view(review()).review;
    expect(model?.summary).toBe(
      "2 turns · 12m of 1h00m · 12 commands · 2 files · 1 outside scope · not reviewed",
    );
    expect(model?.handoff).toMatchObject({
      title: expect.stringMatching(/^Hand-off · turn 1 · \d\d:\d\d:\d\d$/),
      lines: ["Updated the hooks.", "Checks passed."],
    });
    expect(model?.files).toEqual([
      { path: "a.ts", status: "M", added: "+1", removed: "−2", outside: false, selected: true },
      { path: "b.ts", status: "A", added: "+3", removed: "−0", outside: true, selected: false },
    ]);
    expect(model?.filesNote).toBe("1 outside scope");
  });
  it("reports all files in scope and recorded review status", () => {
    const data = finished();
    const state = key(inspectStart({ ...data, run: { ...data.run, reviewedAt: at() } }), "r");
    expect(view(state).review).toMatchObject({ reviewed: true, filesNote: "all in scope" });
    expect(view(state).review?.summary).toMatch(/ · reviewed$/);
  });
  it("explains deferred decisions using the next message after the deferral", () => {
    const events = [
      ...detailEvents(),
      {
        seq: 11,
        at: at(),
        event: { _tag: "AgentMessage", text: "Kept the API.\nMore detail.", phase: "commentary" },
      } as const,
    ];
    const state = key(inspectStart(finished(), events), "r");
    expect(view(state).review?.decided).toEqual([
      {
        question: "Question 2: keep the API?",
        asked: expect.stringMatching(/^\d\d:\d\d:\d\d$/),
        outcome: "→ Codex went with: Kept the API.",
      },
    ]);
    expect(view(state).review?.lateAnswerHint).toBe("a answer late (starts a follow-up turn)");
  });
  it("shows missing deferred outcomes rather than inventing an answer", () => {
    expect(view(key(inspectStart(finished()), "r")).review?.decided[0]?.outcome).toBe(
      "→ deferred, no answer recorded",
    );
  });
  it("cycles hand-off, decided, files and diff, restoring review on diff escape", () => {
    let state = review();
    expect(view(state).review?.focus).toBe("handoff");
    state = key(state, "tab");
    expect(view(state).review?.focus).toBe("decided");
    state = key(state, "tab");
    expect(view(state).review?.focus).toBe("files");
    state = key(state, "j");
    expect(state.detail?.changes?.selected).toBe(1);
    const diff = key(state, "d");
    expect(view(diff).diff?.title).toBe("b.ts · 2 of 2");
    expect(view(key(diff, "escape")).review?.focus).toBe("files");
    state = key(state, "tab");
    expect(view(state).review?.focus).toBe("diff");
    expect(state.detail?.diff?.path).toBe("b.ts");
    expect(view(key(state, "tab")).review?.focus).toBe("handoff");
  });
  it("marks reviewed through acting confirmation and a review intent", () => {
    let state = key(review(), "r");
    expect(state.act.overlay).toEqual({ kind: "confirm-acting", resume: "review" });
    state = key(state, "y");
    expect(state.act.inFlight?.intent).toEqual({ kind: "enter-acting" });
    state = reduce(state, {
      type: "act-outcome",
      outcome: { id: state.act.inFlight?.id ?? -1, ok: true, text: "acting" },
    });
    expect(state.act.inFlight?.intent).toEqual({ kind: "review", name: state.detail?.name });
    state = reduce(state, {
      type: "act-outcome",
      outcome: { id: state.act.inFlight?.id ?? -1, ok: true, text: "reviewed done" },
    });
    expect(state.act.notice?.text).toBe("reviewed done");
  });
  it("retains follow-up and archive actions in review", () => {
    const state = review();
    const acting = { ...state, act: { ...state.act, mode: "acting" as const } };
    expect(key(acting, "F").act.overlay?.kind).toBe("compose");
    expect(key(acting, "x").act.overlay?.kind).toBe("confirm-archive");
  });
  it("marks changed finished list rows for review, and reviewed rows as muted", () => {
    const runs = [
      run("ready", { state: "idle", filesWritten: 3 }),
      run("seen", { state: "failed", filesWritten: 1, reviewedAt: at() }),
      run("clean", { state: "idle", filesWritten: 0 }),
    ];
    const state = reduce(
      initialState({ group: "/repo", defaults, version: "dev", now, columns: 100, rows: 40 }),
      { type: "feed", value: live(runs) },
    );
    const rows = view(state).groups.flatMap((g) => g.rows);
    expect(rows.find((r) => r.name === "ready")?.review).toEqual({
      text: "3 files · r review",
      key: "r",
      bold: true,
      tone: "fg",
    });
    expect(rows.find((r) => r.name === "seen")?.review).toEqual({
      text: "reviewed",
      key: null,
      bold: false,
      tone: "muted",
    });
    expect(rows.find((r) => r.name === "clean")?.review).toBeNull();
  });
  it("includes up to three feed lines before the answer's own question", () => {
    const q = question.id;
    if (!q) throw new Error("question fixture missing");
    const data = detail(run("answer", { state: "waiting", questions: [q] }));
    const events = [
      ...detailEvents().slice(0, 5),
      {
        seq: 6,
        at: at(),
        event: { _tag: "QuestionAsked", id: q.id, kind: q.kind, question: q.text },
      } as const,
    ];
    const state = inspectStart(data, events);
    const acting = { ...state, act: { ...state.act, mode: "acting" as const } };
    expect(view(key(acting, "a")).act.answer?.context.map((l) => l.text)).toEqual([
      "bun run lint",
      "bun run test",
      "write src/hooks.ts",
    ]);
    const noEvents = reduce(acting, {
      type: "detail-feed",
      name: data.run.name,
      value: detailLive(data, []),
    });
    expect(view(key(noEvents, "a")).act.answer?.context).toHaveLength(3);
  });
});
