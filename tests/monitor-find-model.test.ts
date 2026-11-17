import { describe, expect, it } from "vitest";
import { initialState, reduce, view } from "../src/core/monitor/model";
import type { State } from "../src/core/monitor/model-types";
import type { RunView } from "../src/schemas/monitor";
import { at, defaults, live, now, question, run } from "./helpers/monitor";

const key = (state: State, key: string) => reduce(state, { type: "key", key });
const type = (state: State, text: string) => [...text].reduce(key, state);
const start = (runs: readonly RunView[] = [run()]) =>
  reduce(initialState({ group: "/repo", defaults, version: "test", now, columns: 140, rows: 40 }), {
    type: "feed",
    value: live(runs),
  });
const filter = (state: State, text: string) => key(type(key(state, "/"), text), "enter");
const names = (state: State) =>
  view(state).groups.flatMap((group) => group.rows.map((r) => r.name));
const questions = question.id ? [question.id] : [];
const choose = (state: State, label: string) => key(type(key(state, ":"), label), "enter");

describe("monitor filter", () => {
  it("opens, edits printable text, deletes a character and keeps the text on Enter", () => {
    const opened = key(start(), "/");
    expect(view(opened).filterBar).toEqual({
      text: "",
      editing: true,
      shown: 1,
      total: 1,
      hiddenWaiting: 0,
    });
    const edited = key(type(opened, "hookx"), "backspace");
    expect(view(key(edited, "enter")).filterBar).toEqual({
      text: "hook",
      editing: false,
      shown: 1,
      total: 1,
      hiddenWaiting: 0,
    });
  });
  it("Escape clears and closes the input", () => {
    const editing = type(key(start(), "/"), "missing");
    expect(view(editing).filterBar?.editing).toBe(true);
    const state = key(editing, "escape");
    expect(state.filter).toEqual({ text: "", editing: false });
    expect(view(state).filterBar).toBeNull();
    expect(names(state)).toEqual(["fix-hooks"]);
  });
  it("captures list, acting and help shortcuts as text while editing", () => {
    const state = type(key(start([run("a"), run("b")]), "/"), "j?g:h!asFidxw");
    expect(state.filter).toEqual({ text: "j?g:h!asFidxw", editing: true });
    expect(state).toMatchObject({
      help: false,
      history: null,
      palette: null,
      grouping: "repo",
      detail: null,
    });
    expect(state.act).toMatchObject({ overlay: null, inFlight: null });
  });
  it("accepts whole filter text from a controlled input and ignores it when closed", () => {
    const state = reduce(key(start(), "/"), { type: "filter-text", text: "MODEL:SOL hooks" });
    expect(view(state).filterBar?.text).toBe("MODEL:SOL hooks");
    expect(names(state)).toEqual(["fix-hooks"]);
    expect(reduce(key(state, "enter"), { type: "filter-text", text: "missing" }).filter.text).toBe(
      "MODEL:SOL hooks",
    );
  });
  it.each([
    ["state:running,waiting", ["alpha", "beta"]],
    ["repo:TOOLS", ["beta"]],
    ["model:luna", ["beta"]],
    ["model:MEDIUM", ["beta"]],
    ["ALPHA", ["alpha"]],
    ["migrate", ["beta"]],
    ["compiling", ["alpha"]],
    ["owner:alice", ["beta"]],
    ["state:waiting repo:tools model:medium migrate", ["beta"]],
    ["alpha migrate", []],
  ])("matches all tokens in %s", (text, expected) => {
    const state = filter(
      start([
        run("alpha", {
          title: "Update cache",
          activity: { kind: "message", text: "Compiling", since: at() },
        }),
        run("beta", {
          state: "waiting",
          repo: "/work/TOOLS",
          title: "Migrate owner:alice",
          model: "gpt-6-luna",
          effort: "medium",
        }),
        run("gamma", { state: "idle", title: null, activity: null }),
      ]),
      text,
    );
    expect(names(state)).toEqual(expected);
  });
  it("keeps question notes and pins visible, reports hidden waiting rows and group counts", () => {
    const state = filter(
      start([
        run("visible"),
        run("waiting", { state: "waiting", questions }),
        run("failed", { state: "failed" }),
        run("remote", { group: "/other", repo: "/other", state: "waiting", questions }),
      ]),
      "visible",
    );
    const model = view(state);
    expect(names(state)).toEqual(["visible"]);
    expect(model.notes.map((note) => note.id)).toEqual(["waiting:q2", "remote:q2"]);
    expect(model.pinned.map((row) => row.name)).toEqual(["failed"]);
    expect(model.filterBar).toMatchObject({ shown: 1, total: 4, hiddenWaiting: 2 });
    expect(model.groups.map((g) => [g.id, g.summary])).toEqual([
      ["/repo", "1 shown · 2 hidden by filter"],
      ["/other", "0 shown · 1 hidden by filter"],
    ]);
  });
  it("moves a filtered selection to the first visible run and clears it when none match", () => {
    let state = key(key(start([run("a"), run("b"), run("c"), run("d")]), "j"), "j");
    state = reduce(key(state, "/"), { type: "filter-text", text: "state:running repo:repo" });
    expect(view(state).selected).toBe("c");
    state = reduce(key(state, "/"), { type: "filter-text", text: "a" });
    expect(view(state).selected).toBe("a");
    state = reduce(state, { type: "filter-text", text: "zzzz" });
    expect(view(state).selected).toBeNull();
  });
  it("selects the first visible run when a feed update stops matching the filter", () => {
    let state = key(filter(start([run("a"), run("b"), run("c")]), "state:running"), "end");
    expect(view(state).filterBar?.text).toBe("state:running");
    state = reduce(state, {
      type: "feed",
      value: live([run("a"), run("b"), run("c", { state: "idle" })]),
    });
    expect(view(state).selected).toBe("a");
  });
  it("toggles needs:me within the filter text and includes questions and all pin candidates", () => {
    const entries = [
      run("normal"),
      run("waiting", { questions }),
      run("failed", { state: "failed" }),
      run("budget", { turnStartedAt: at(-3240000) }),
      run("quiet", { quiet: true, activity: null }),
      run("flags", { hooksBlocked: 1, unansweredCount: 2 }),
    ];
    const state = key(filter(start(entries), "repo:repo"), "!");
    expect(state.filter.text).toBe("repo:repo needs:me");
    expect(names(state).sort()).toEqual(["budget", "failed", "quiet", "waiting"]);
    expect(view(state).footer.attentionOnly).toBe(true);
    expect(key(state, "!").filter.text).toBe("repo:repo");
    const duplicate = filter(start(entries), "NEEDS:ME needs:me repo:repo");
    expect(key(duplicate, "!").filter.text).toBe("repo:repo");
  });
  it("counts matching collapsed older runs in the filter bar", () => {
    const state = filter(start([run("old", { state: "idle", stateSince: at(-90000000) })]), "old");
    expect(view(state).filterBar).toMatchObject({ shown: 1, total: 1 });
    expect(view(state).groups[0]?.older).not.toBeNull();
  });
  it("clears an acting notice on a find key", () => {
    const state = key(start(), "a");
    expect(view(state).act.notice).not.toBeNull();
    expect(view(key(state, "!")).act.notice).toBeNull();
  });
  it("keeps a matching collapsed older row selected when its filter is edited", () => {
    const state = start([
      run("a-active"),
      run("z-old", { state: "idle", stateSince: at(-90000000) }),
    ]);
    const selected = key(state, "end");
    const edited = reduce(key(selected, "/"), { type: "filter-text", text: "repo:repo" });
    expect(view(edited).selected).toBe("older:/repo");
    expect(view(key(key(edited, "enter"), "enter")).groups[0]?.rows.map((r) => r.name)).toEqual([
      "a-active",
      "z-old",
    ]);
  });
  it("targets a still-visible question note through a filter that hides its run", () => {
    const state = filter(
      start([run("visible"), run("waiting", { state: "waiting", questions })]),
      "visible",
    );
    const acting: State = { ...state, act: { ...state.act, mode: "acting" } };
    expect(names(acting)).toEqual(["visible"]);
    expect(view(acting).notes.map((note) => note.id)).toEqual(["waiting:q2"]);
    expect(key(acting, "a").act.overlay).toMatchObject({
      kind: "answer",
      target: { name: "waiting", question: "q2" },
    });
  });
  it("preserves the exported attention-only state for callers that seed it directly", () => {
    const state: State = {
      ...start([run("normal"), run("waiting", { state: "waiting", questions })]),
      attentionOnly: true,
    };
    expect(names(state)).toEqual(["waiting"]);
    expect(view(state).groups[0]?.summary).toBe("1 waiting");
  });
  it("reserves the filter bar row when keeping the last run in view", () => {
    const initial = start(
      Array.from({ length: 20 }, (_, i) =>
        run(`run-${String(i).padStart(2, "0")}`, { state: "idle" }),
      ),
    );
    const state = reduce(initial, { type: "resize", columns: 140, rows: 12 });
    const end = key(filter(state, "state:idle"), "end");
    expect(view(end).selected).toBe("run-19");
    const lastRowEnd = 42;
    expect(lastRowEnd).toBeLessThanOrEqual(view(end).offset + 9);
    expect(view(key(end, "page-down")).offset + 9).toBeGreaterThanOrEqual(lastRowEnd);
  });
  it("pages by the height above the preview and below the filter bar", () => {
    const initial = start(
      Array.from({ length: 40 }, (_, i) =>
        run(`run-${String(i).padStart(2, "0")}`, { state: "idle" }),
      ),
    );
    const state = reduce(initial, { type: "resize", columns: 140, rows: 30 });
    const filtered = filter(state, "state:idle");
    expect(view(key(filtered, "page-down")).offset).toBe(22);
    expect(view(key(key(filtered, "page-down"), "page-up")).offset).toBe(0);
  });
});

describe("monitor grouping", () => {
  it("cycles repo to state to recent to repo and preserves a visible selection", () => {
    const entries = (
      [
        "idle",
        "lost",
        "unknown",
        "interrupted",
        "failed",
        "starting",
        "running",
        "waiting",
      ] as const
    ).map((state, index) =>
      run(state, { state, stateSince: at(-index * 60000), lastActivityAt: at() }),
    );
    const state = key(start(entries), "g");
    expect(view(state).grouping).toBe("state");
    expect(view(state).groups.map((g) => g.title)).toEqual([
      "waiting",
      "running",
      "starting",
      "failed",
      "interrupted",
      "unknown",
      "lost",
      "idle",
    ]);
    const recent = key(state, "g");
    expect(view(recent).groups.map((g) => g.title)).toEqual(["recent"]);
    expect(names(recent)).toEqual(entries.map((r) => r.name));
    expect(view(recent).selected).toBe(view(state).selected);
    expect(view(key(recent, "g")).grouping).toBe("repo");
  });
});

describe("monitor command palette", () => {
  it("offers no actions for an unknown run, which the daemon treats as active", () => {
    const model = view(key(start([run("subject", { state: "unknown" })]), ":"));
    expect(
      model.palette?.items.filter(
        (item) => !item.heading && ["i", "s", "F", "a", "d", "x"].includes(item.key ?? ""),
      ),
    ).toEqual([]);
  });
  it.each([
    ["running", ["interrupt", "steer"]],
    ["starting", ["interrupt", "steer"]],
    ["waiting", ["interrupt", "answer q2", "defer q2"]],
    ["idle", ["follow up", "archive"]],
    ["failed", ["follow up", "archive"]],
    ["interrupted", ["follow up", "archive"]],
    ["lost", ["archive"]],
  ] as const)("lists eligible actions for %s with a watching heading", (state, expected) => {
    const model = view(
      key(start([run("subject", { state, questions: state === "waiting" ? questions : [] })]), ":"),
    );
    expect(model.palette).toMatchObject({ query: "", subject: "subject" });
    expect(model.palette?.items.filter((item) => item.heading).map((item) => item.label)).toEqual([
      "actions switch the monitor to acting",
    ]);
    expect(
      model.palette?.items
        .filter((item) => !item.heading && ["i", "s", "F", "a", "d", "x"].includes(item.key ?? ""))
        .map((item) => item.label),
    ).toEqual(expected);
    expect(model.palette?.items.filter((item) => item.selected).map((item) => item.label)).toEqual([
      expected[0],
    ]);
  });
  it("filters labels without treating letters or ? as shortcuts and supports backspace", () => {
    const state = type(key(start(), ":"), "STEER?");
    expect(state.help).toBe(false);
    expect(state.act.overlay).toBeNull();
    expect(view(state).palette?.items).toEqual([]);
    const edited = key(state, "backspace");
    expect(
      view(edited)
        .palette?.items.filter((i) => !i.heading)
        .map((i) => i.label),
    ).toEqual(["steer", "copy command: foreman steer fix-hooks --file <path>"]);
    expect(key(edited, "escape").palette).toBeNull();
  });
  it("moves through actionable items, clamps, and executes the highlighted key", () => {
    const opened = key(start(), ":");
    const down = key(opened, "down");
    expect(view(down).palette?.items.find((i) => i.selected)?.label).toBe("steer");
    expect(key(down, "enter")).toEqual(key(start(), "s"));
    expect(view(key(key(opened, "up"), "up")).palette?.items.find((i) => i.selected)?.label).toBe(
      "interrupt",
    );
    let end = opened;
    for (let i = 0; i < 30; i++) end = key(end, "down");
    expect(view(end).palette?.items.find((i) => i.selected)?.label).toBe("help");
  });
  it.each([
    ["interrupt", "i", "running"],
    ["steer", "s", "running"],
    ["follow up", "F", "idle"],
    ["answer q2", "a", "waiting"],
    ["defer q2", "d", "waiting"],
    ["archive", "x", "idle"],
  ] as const)("executes %s by the existing acting path", (label, shortcut, state) => {
    const watching = start([run("subject", { state, questions })]);
    const acting: State = { ...watching, act: { ...watching.act, mode: "acting" } };
    expect(view(key(acting, ":")).palette?.items.some((i) => i.heading)).toBe(false);
    expect(choose(acting, label)).toEqual(key(acting, shortcut));
  });
  it.each(["answer q2", "defer q2"])(
    "keeps the selected non-waiting run as the %s palette subject",
    (label) => {
      const initial = start([
        run("first", { state: "waiting", questions }),
        run("subject", { state: "unknown", questions }),
      ]);
      const selected = key(initial, "end");
      const acting: State = { ...selected, act: { ...selected.act, mode: "acting" } };
      const executed = choose(acting, label);
      if (label.startsWith("answer"))
        expect(executed.act.overlay).toMatchObject({
          kind: "answer",
          target: { name: "subject", question: "q2" },
        });
      else
        expect(executed.act.inFlight?.intent).toMatchObject({
          kind: "defer",
          name: "subject",
          question: "q2",
        });
    },
  );
  it.each(["a", "d"])("keeps the selected unknown run's question for direct %s", (shortcut) => {
    const initial = start([
      run("first", { state: "waiting", questions }),
      run("subject", { state: "unknown", questions }),
    ]);
    const selected = key(initial, "end");
    const acting: State = { ...selected, act: { ...selected.act, mode: "acting" } };
    const executed = key(acting, shortcut);
    if (shortcut === "a")
      expect(executed.act.overlay).toMatchObject({
        kind: "answer",
        target: { name: "subject", question: "q2" },
      });
    else
      expect(executed.act.inFlight?.intent).toMatchObject({
        kind: "defer",
        name: "subject",
        question: "q2",
      });
  });
  it("retains the selected unknown question when a palette answer confirms acting", () => {
    const initial = start([
      run("first", { state: "waiting", questions }),
      run("subject", { state: "unknown", questions }),
    ]);
    const confirmed = key(choose(key(initial, "end"), "answer q2"), "y");
    const flight = confirmed.act.inFlight;
    if (!flight) throw new Error("Expected an enter-acting request.");
    const executed = reduce(confirmed, {
      type: "act-outcome",
      outcome: { id: flight.id, ok: true, text: "Acting" },
    });
    expect(executed.act.overlay).toMatchObject({
      kind: "answer",
      target: { name: "subject", question: "q2" },
    });
  });
  it.each([
    ["answer", "foreman answer subject q2 --file <path>"],
    ["steer", "foreman steer subject --file <path>"],
    ["followup", "foreman followup subject --file <path>"],
    ["interrupt", "foreman interrupt subject"],
    ["status", "foreman status subject"],
  ])(
    "copies a %s command without entering acting and gives repeat requests distinct ids",
    (command, text) => {
      const state = start([run("subject", { state: "waiting", questions })]);
      const first = choose(state, `copy command: foreman ${command}`);
      expect(first.clipboard).toEqual({ id: 1, text });
      expect(view(first).act.notice).toMatchObject({ ok: true, text: `copied: ${text}` });
      expect(first.act).toMatchObject({ mode: "watching", overlay: null, inFlight: null });
      expect(choose(first, `copy command: foreman ${command}`).clipboard).toEqual({ id: 2, text });
    },
  );
  it("offers general commands without a selected run and does nothing on no matches", () => {
    const state = start([]);
    expect(view(key(state, ":")).palette?.items.map((i) => i.label)).toEqual([
      "group by state",
      "history",
      "filter",
      "help",
    ]);
    const empty = type(key(state, ":"), "zzzz");
    expect(key(empty, "enter")).toEqual(empty);
  });
  it("offers all five command copies even when the selected run has no pending question", () => {
    const state = key(start(), ":");
    expect(
      view(state)
        .palette?.items.filter((item) => item.label.startsWith("copy command:"))
        .map((item) => item.label),
    ).toEqual([
      "copy command: foreman answer fix-hooks <q> --file <path>",
      "copy command: foreman steer fix-hooks --file <path>",
      "copy command: foreman followup fix-hooks --file <path>",
      "copy command: foreman interrupt fix-hooks",
      "copy command: foreman status fix-hooks",
    ]);
  });
  it.each([
    ["group by state", "g"],
    ["history", "h"],
    ["filter", "/"],
    ["help", "?"],
  ])("executes %s", (label, shortcut) => {
    expect(choose(start(), label)).toEqual(key(start(), shortcut));
  });
  it("keeps acting overlays in control of input", () => {
    const state = key(start(), "s");
    expect(key(state, ":").palette).toBeNull();
    expect(key(state, "/").filter.editing).toBe(false);
  });
  it("exposes find keys in help and still toggles help with ?", () => {
    const state = key(start(), "?");
    expect(view(state).overlay).toBe(true);
    expect(view(state).helpKeys.map((hint) => hint.key)).toEqual(["/", ":", "g", "h", "!"]);
    expect(view(key(state, "?")).overlay).toBe(false);
  });
});
