import { describe, expect, it } from "vitest";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { DETAIL_PANES } from "../src/core/monitor/model-types";
import type { ChangedFile } from "../src/core/runs/changes";
import {
  at,
  defaults,
  detail,
  detailEvents,
  detailLive,
  focusFiles,
  inspectStart,
  monitorKey as key,
  live,
  messageEvents,
  now,
  run,
} from "./helpers/monitor";

const files: readonly ChangedFile[] = [
  { path: "src/a.ts", status: "modified", added: 42, removed: 7, outside: false },
  { path: "notes.txt", status: "untracked", added: 2, removed: 0, outside: true },
];
const loaded = () => {
  const state = inspectStart();
  return reduce(state, {
    type: "changes-result",
    id: state.detail?.changes?.id ?? -1,
    files,
    error: null,
  });
};
const pane = (state: ReturnType<typeof inspectStart>) =>
  view(state).detail?.panes.find((p) => p.id === "files");
const feed = (state: ReturnType<typeof inspectStart>) =>
  view(state).detail?.panes.find((p) => p.id === "feed");

describe("monitor inspection", () => {
  it.each([
    [false, 36],
    [true, 35],
  ])("pages a full-screen diff with truncation=%s by its visible rows", (truncated, page) => {
    let state = key(focusFiles(loaded()), "d");
    const id = state.detail?.diff?.id;
    if (id === undefined) throw new Error("Expected diff request");
    state = reduce(state, {
      type: "diff-result",
      id,
      error: null,
      text: {
        text: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n"),
        truncated,
      },
    });
    const next = key(state, "page-down");
    expect(view(next).diff?.offset).toBe(page);
    expect(view(key(next, "page-up")).diff?.offset).toBe(0);
  });
  it("visits the first hunk from patch headers, including one-hunk diffs", () => {
    const opened = key(focusFiles(loaded()), "d");
    for (const text of [
      "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b",
      "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n-c\n+d",
    ]) {
      const state = reduce(opened, {
        type: "diff-result",
        id: 2,
        text: { text, truncated: false },
        error: null,
      });
      expect(key(state, "n").detail?.diff?.offset).toBe(1);
    }
  });
  it("returns to file selection on refresh so reverted paths cannot leave stale diffs", () => {
    let state = key(focusFiles(loaded()), "d");
    state = reduce(state, {
      type: "diff-result",
      id: 2,
      text: { text: "@@ -1 +1 @@\n-a\n+b", truncated: false },
      error: null,
    });
    state = key(state, "R");
    expect(state.detail?.diff).toBeNull();
    expect(state.detail?.focus).toBe("files");
    expect(reduce(state, { type: "diff-result", id: 2, text: null, error: "old request" })).toEqual(
      state,
    );
    state = reduce(state, { type: "changes-result", id: 3, files: files.slice(1), error: null });
    expect(view(key(state, "d")).diff?.title).toBe("notes.txt · 1 of 1");
  });
  it("preserves a paused filtered feed's anchor when unrelated events leave the buffer", () => {
    const events = messageEvents(1000).map((entry) =>
      entry.seq % 10 === 0
        ? {
            ...entry,
            event: {
              _tag: "Command" as const,
              command: `check ${entry.seq}`,
              status: "completed",
              exitCode: 0,
              outputTail: "",
            },
          }
        : entry,
    );
    let state = key(inspectStart(detail(), events), "2");
    for (let i = 0; i < 10 && state.detail?.focus !== "feed"; i++) state = key(state, "tab");
    state = key(key(state, "f"), "home");
    const before = feed(state);
    const anchor = before?.lines[before.offset]?.text;
    state = reduce(state, {
      type: "detail-feed",
      name: detail().run.name,
      value: detailLive(detail(), messageEvents(1, 1001)),
    });
    const after = feed(state);
    expect(anchor).toBe("check 10");
    expect(after?.lines[after.offset]?.text).toBe(anchor);
  });
  it("keeps list filter input in control of the review shortcut", () => {
    const list = reduce(
      initialState({ group: "/repo", defaults, version: "dev", now, columns: 100, rows: 40 }),
      { type: "feed", value: live([run("ready", { state: "idle" })]) },
    );
    const state = key(key(list, "/"), "r");
    expect(state.detail).toBeNull();
    expect(state.filter).toEqual({ text: "r", editing: true });
  });
  it("exposes the selected file and keeps it visible in a long Files pane", () => {
    let state = reduce(inspectStart(), {
      type: "changes-result",
      id: 1,
      files: Array.from({ length: 20 }, (_, i) => ({
        path: `src/${i}.ts`,
        status: "modified" as const,
        added: 1,
        removed: 1,
        outside: false,
      })),
      error: null,
    });
    state = focusFiles(state);
    for (let i = 0; i < 10; i++) state = key(state, "j");
    const filesPane = pane(state);
    expect(filesPane?.lines.filter((line) => line.selected).map((line) => line.text)).toEqual([
      "M src/10.ts  +1 −1",
    ]);
    expect(
      filesPane?.lines
        .slice(filesPane.offset, filesPane.offset + filesPane.height - 2)
        .some((line) => line.selected),
    ).toBe(true);
  });
  it("ignores replies after closing detail and after opening another run", () => {
    const state = key(inspectStart(), "escape");
    expect(reduce(state, { type: "changes-result", id: 1, files, error: null })).toEqual(state);
    const list = reduce(state, { type: "feed", value: live([run("other")]) });
    const reopened = key(list, "enter");
    expect(reopened.detail?.changes?.id).toBe(2);
    expect(reduce(reopened, { type: "changes-result", id: 1, files, error: null })).toEqual(
      reopened,
    );
  });
  it("renders binary numstat and every file status", () => {
    const state = reduce(inspectStart(), {
      type: "changes-result",
      id: 1,
      files: [
        { path: "image.png", status: "added", added: null, removed: null, outside: false },
        { path: "old.ts", status: "deleted", added: 0, removed: 2, outside: false },
        { path: "new.ts", status: "renamed", added: 1, removed: 0, outside: false },
      ],
      error: null,
    });
    expect(pane(state)?.lines.map((line) => line.text)).toEqual([
      "A image.png  binary binary",
      "D old.ts  +0 −2",
      "R new.ts  +1 −0",
    ]);
  });
  it("requests changes on direct and list detail entry, before the feed pane", () => {
    const direct = inspectStart();
    expect(direct.detail?.changes).toEqual({ id: 1, files: null, error: null, selected: 0 });
    expect(direct.nextInspectId).toBe(2);
    const list = reduce(
      initialState({ group: "/repo", defaults, version: "dev", now, columns: 100, rows: 40 }),
      { type: "feed", value: live() },
    );
    expect(key(list, "enter").detail?.changes?.id).toBe(1);
    expect(DETAIL_PANES.slice(-2)).toEqual(["files", "feed"]);
    expect(pane(direct)?.lines.map((l) => l.text)).toEqual(["loading changes…"]);
  });
  it("renders file counts, numstat and outside scope marks", () => {
    expect(pane(loaded())).toMatchObject({
      title: "Files · 2 changed",
      lines: [{ text: "M src/a.ts  +42 −7" }, { text: "? notes.txt  +2 −0  ▲ outside May change" }],
    });
  });
  it("shows an empty change list", () => {
    const state = inspectStart();
    expect(
      pane(reduce(state, { type: "changes-result", id: 1, files: [], error: null }))?.lines.map(
        (l) => l.text,
      ),
    ).toEqual(["No changes."]);
  });
  it("shows change failures and ignores stale results after refresh", () => {
    const state = key(loaded(), "R");
    expect(state.detail?.changes).toEqual({ id: 2, files: null, error: null, selected: 0 });
    expect(reduce(state, { type: "changes-result", id: 1, files, error: null })).toEqual(state);
    expect(
      pane(
        reduce(state, {
          type: "changes-result",
          id: 2,
          files: null,
          error: "git permission denied",
        }),
      )?.lines[0]?.text,
    ).toBe("git permission denied");
  });
  it("moves file selection rather than scrolling and requests its diff", () => {
    const state = key(key(focusFiles(loaded()), "j"), "j");
    expect(state.detail?.changes?.selected).toBe(1);
    expect(state.detail?.offsets.files).toBe(0);
    const opened = key(state, "d");
    expect(opened.detail?.diff).toEqual({
      id: 2,
      path: "notes.txt",
      text: null,
      error: null,
      offset: 0,
    });
    expect(view(opened).diff).toMatchObject({ title: "notes.txt · 2 of 2", status: "loading" });
    expect(key(opened, "escape").detail?.focus).toBe("files");
    expect(key(state, "k").detail?.changes?.selected).toBe(0);
  });
  it("does not defer or open a diff when Files is empty", () => {
    const state = reduce(inspectStart(), { type: "changes-result", id: 1, files: [], error: null });
    expect(key(focusFiles(state), "d").detail?.diff).toBeNull();
    expect(key(focusFiles(state), "d").act.overlay).toBeNull();
  });
  it("fills matching diff requests and exposes failures", () => {
    const state = key(focusFiles(loaded()), "d");
    expect(reduce(state, { type: "diff-result", id: 123, text: null, error: "stale" })).toEqual(
      state,
    );
    const failed = reduce(state, {
      type: "diff-result",
      id: 2,
      text: null,
      error: "diff unavailable",
    });
    expect(view(failed).diff).toMatchObject({ status: "failed", message: "diff unavailable" });
  });
  it("pages the whole diff and clears only its own result, reporting errors", () => {
    const state = key(loaded(), "D");
    expect(state.pager).toEqual({ id: 2, name: state.detail?.name });
    expect(reduce(state, { type: "pager-result", id: 1, error: null })).toEqual(state);
    const failed = reduce(state, { type: "pager-result", id: 2, error: "PAGER exited 1" });
    expect(failed.pager).toBeNull();
    expect(view(failed).act.notice).toMatchObject({ ok: false, text: "PAGER exited 1" });
    expect(reduce(state, { type: "pager-result", id: 2, error: null }).pager).toBeNull();
  });
  it("navigates diff lines, pages, boundaries and hunks", () => {
    let state = key(focusFiles(loaded()), "d");
    const text = "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n@@ -50 +50 @@\n-last\n+end";
    state = reduce(state, {
      type: "diff-result",
      id: 2,
      text: { text, truncated: false },
      error: null,
    });
    expect(view(state).diff?.position).toBe("hunk 1 of 2");
    expect(key(state, "j").detail?.diff?.offset).toBe(1);
    expect(key(key(state, "j"), "k").detail?.diff?.offset).toBe(0);
    expect(key(key(state, "j"), "n").detail?.diff?.offset).toBe(4);
    expect(key(key(key(state, "j"), "n"), "p").detail?.diff?.offset).toBe(1);
    expect(key(state, "end").detail?.diff?.offset).toBe(6);
    expect(key(key(state, "end"), "home").detail?.diff?.offset).toBe(0);
    expect(key(state, "page-down").detail?.diff?.offset).toBe(6);
    expect(key(key(state, "page-down"), "page-up").detail?.diff?.offset).toBe(0);
  });
  it("requests adjacent file diffs and keeps boundary keys in the diff", () => {
    const state = key(focusFiles(loaded()), "d");
    const next = key(state, "]");
    expect(next.detail?.diff).toMatchObject({ id: 3, path: "notes.txt", text: null });
    expect(view(next).diff?.title).toBe("notes.txt · 2 of 2");
    expect(key(next, "]")).toEqual(next);
    expect(key(next, "[").detail?.diff?.path).toBe("src/a.ts");
  });
  it("adds a truncation notice with the actual byte size", () => {
    const state = key(focusFiles(loaded()), "d");
    const result = reduce(state, {
      type: "diff-result",
      id: 2,
      text: { text: "+é", truncated: true },
      error: null,
    });
    expect(view(result).diff?.lines.at(-1)).toMatchObject({
      kind: "meta",
      text: "… diff cut at 3 bytes; D opens the whole diff in $PAGER",
    });
  });
  it.each([
    ["1", "all", 14],
    ["2", "commands", 3],
    ["3", "files", 1],
    ["4", "messages", 1],
    ["5", "questions", 7],
  ])("filters %s to %s", (shortcut, filter, count) => {
    const state = key(inspectStart(), shortcut);
    expect(view(state).feedTabs).toEqual({ filter, search: "", editing: false });
    expect(feed(state)?.title).toBe("Feed");
    expect(feed(state)?.lines).toHaveLength(count);
  });
  it("searches feed text case-insensitively, Enter keeps it and Escape clears it", () => {
    let state = key(inspectStart(), "/");
    expect(view(state).feedTabs?.editing).toBe(true);
    state = reduce(state, { type: "feed-search-text", text: "LINT" });
    expect(feed(state)?.lines.map((l) => l.text)).toEqual([
      "bun run lint",
      "pre-commit: Fix lint first.",
    ]);
    expect(key(state, "5").detail?.feedFilter).toBe("all");
    state = key(state, "enter");
    expect(view(state).feedTabs).toEqual({ filter: "all", search: "LINT", editing: false });
    state = key(key(state, "/"), "escape");
    expect(view(state).feedTabs).toEqual({ filter: "all", search: "", editing: false });
    expect(state.detail).not.toBeNull();
  });
  it("leaves action input in control of filter and diff keys", () => {
    const state = inspectStart();
    const overlay = {
      ...state,
      act: { ...state.act, overlay: { kind: "confirm-acting", resume: "answer" } as const },
    };
    expect(key(overlay, "/").detail?.feedSearch.editing).toBe(false);
    expect(key(overlay, "2").detail?.feedFilter).toBe("all");
    expect(key(overlay, "D").pager).toBeNull();
  });
  it("draws timeline slices with working, quiet, failed and question marks", () => {
    const data = detail(run("timeline", { state: "running", subagents: detail().run.subagents }));
    const events = detailEvents().map((event, index) => ({
      ...event,
      at: at(-3500000 + index * 300000),
    }));
    const model = view(inspectStart(data, events));
    expect(model.timeline?.cells).toHaveLength(100);
    expect(model.timeline?.cells).toContainEqual({ glyph: "━", tone: "running" });
    expect(model.timeline?.cells).toContainEqual({ glyph: "┄", tone: "muted" });
    expect(model.timeline?.cells).toContainEqual({ glyph: "×", tone: "failed" });
    expect(model.timeline?.cells).toContainEqual({ glyph: "■", tone: "signal" });
    expect(model.timeline?.subagentCells).toHaveLength(100);
    expect(model.timeline?.ticks).toMatch(/\d\d:\d\d/);
    expect(model.timeline?.legend).toBe("━ working  × failed command  ┄ quiet  ■ question");
  });
  it("hides timeline below 40 columns and outside detail, with no phantom subagents", () => {
    const state = inspectStart(detail(run()));
    expect(view(state).timeline?.subagentCells).toBeNull();
    expect(view(reduce(state, { type: "resize", columns: 39, rows: 40 })).timeline).toBeNull();
    expect(view(key(state, "escape")).timeline).toBeNull();
  });
  it("ends an inactive timeline at the last event and keeps it fixed on ticks", () => {
    const state = inspectStart(
      detail(run("done", { state: "idle" })),
      detailEvents().map((e) => ({ ...e, at: at(-100000) })),
    );
    expect(view(state).timeline).not.toBeNull();
    expect(view(reduce(state, { type: "tick", now: now + 3600000 })).timeline).toEqual(
      view(state).timeline,
    );
  });
});
