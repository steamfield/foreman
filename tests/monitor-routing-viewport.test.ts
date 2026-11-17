import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { createElement } from "react";
import { expect, it } from "vitest";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import {
  at,
  defaults,
  focusFiles,
  inspectStart,
  monitorKey as key,
  live,
  now,
  question,
  run,
} from "./helpers/monitor";

function diffStart() {
  const state = inspectStart();
  const loaded = reduce(state, {
    type: "changes-result",
    id: 1,
    files: [{ path: "src/a.ts", status: "modified", added: 1, removed: 1, outside: false }],
    error: null,
  });
  return key(focusFiles(loaded), "d");
}

it("opens help from a diff and returns to the same diff", () => {
  const state = diffStart();
  const help = key(state, "?");
  expect(view(help).overlay).toBe(true);
  const returned = key(help, "escape");
  expect(view(returned).overlay).toBe(false);
  expect(returned.detail?.diff).toEqual(state.detail?.diff);
});

it("returns from acting to watching while a diff is open", () => {
  const state = diffStart();
  const watching = key({ ...state, act: { ...state.act, mode: "acting" } }, "w");
  expect(watching.act.mode).toBe("watching");
  expect(watching.act.inFlight).toMatchObject({ intent: { kind: "leave-acting" } });
  expect(watching.detail?.diff).toEqual(state.detail?.diff);
});

function listStart() {
  const state = reduce(
    initialState({ group: "/repo", defaults, version: "dev", now, columns: 80, rows: 24 }),
    {
      type: "feed",
      value: live([
        run("waiting", { state: "waiting", questions: question.id ? [question.id] : [] }),
        ...Array.from({ length: 20 }, (_, index) =>
          run(`run-${String(index).padStart(2, "0")}`, {
            activity: {
              kind: "message",
              text: `activity-${index}`,
              since: at(-1000),
            },
          }),
        ),
      ]),
    },
  );
  return key(reduce(key(state, "/"), { type: "filter-text", text: "state:running" }), "enter");
}

it("keeps both lines of the last selection above hidden waiting and notice at 80x24", () => {
  const selected = key(listStart(), "end");
  const state = {
    ...selected,
    act: { ...selected.act, notice: { ok: false, text: "Action failed", at: now } },
  };
  const model = view(state);
  const lines = stripVTControlCharacters(
    renderToString(createElement(Screen, { model, colors: theme(0, true) }), { columns: 80 }),
  ).split("\n");
  expect(model.filterBar?.hiddenWaiting).toBe(1);
  expect(model.preview).toBeNull();
  expect(lines).toHaveLength(24);
  const last = lines.findIndex((line) => line.includes("run-19") && !line.includes("preview"));
  expect(last).toBeGreaterThan(0);
  expect(lines[last + 1]).toContain("activity-19");
  expect(lines.some((line) => line.includes("Action failed"))).toBe(true);
  expect(lines.some((line) => /1.*waiting/.test(line))).toBe(true);
});

it("pages by the drawn list height with a filter hiding a waiting run at 80x24", () => {
  const initial = listStart();
  const state = {
    ...initial,
    act: { ...initial.act, notice: { ok: false, text: "Action failed", at: now } },
  };
  const before = view(state).offset;
  const paged = key(state, "page-down");
  expect(view(paged).act.notice).toBeNull();
  // Header, footer, filter and hidden-waiting line leave 20 lines; preview is hidden at 24 rows.
  expect(view(paged).offset - before).toBe(20);
  expect(view(key(paged, "page-up")).offset).toBe(before);
});
