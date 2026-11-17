import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, expect, it } from "vitest";
import type { ActMessage, ActView } from "../src/core/monitor/act";
import { initialState, reduce, type ViewModel, view } from "../src/core/monitor/model";
import { MonitorApp, Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { at, defaults, detailLive, live, now, run } from "./helpers/monitor";

afterEach(cleanup);
const watching: ActView = {
  chip: { mode: "watching", text: "◇ watching" },
  confirm: null,
  answer: null,
  notice: null,
  hints: null,
};
const answer: NonNullable<ActView["answer"]> = {
  title: "■ answer  fix-hooks q2",
  meta: "question · waited 3m · defers in 12m",
  question:
    "Keep the existing hook API, or can I change the signature of runHook()? It is called from src/daemon/hooks.ts, src/cli.ts and two tests. Passing the run context as a parameter would let me drop the re-read of run.json on every call.",
  draft: "Keep the signature.",
  sending: false,
  resolved: false,
  alsoWaiting: "Also waiting  Claude Code session that started this run. First answer wins.",
};
const answering: ActView = {
  ...watching,
  chip: { mode: "acting", text: "◆ acting" },
  answer,
  hints: [
    { key: "enter", label: "send" },
    { key: "ctrl-d", label: "defer" },
    { key: "esc", label: "cancel" },
  ],
};
const confirming: ActView = {
  ...watching,
  confirm: {
    title: "Switch to acting?",
    lines: [
      "Acting keeps the running daemon alive while this monitor is open.",
      "Return to watching with w.",
    ],
  },
  hints: [
    { key: "y", label: "act" },
    { key: "esc", label: "cancel" },
  ],
};
function model(act = watching, columns = 140, rows = 40): ViewModel {
  const base = view(
    initialState({ group: "/repo", defaults, version: "test", now, columns, rows }),
  );
  return {
    ...base,
    act,
    animating: false,
    header: { ...base.header, daemon: "daemon up 2h", counts: [] },
    screen: "list",
    message: [],
    groups: [{ id: "/repo", title: "repo", summary: "1 running", rows: [], older: null }],
  };
}
function frame(value: ViewModel, noColor = false) {
  return renderToString(createElement(Screen, { model: value, colors: theme(3, noColor) }), {
    columns: value.columns,
  });
}
const plain = (text: string) => stripVTControlCharacters(text);

it("places watching after the version", () => {
  expect(plain(frame(model())).split("\n")[0]).toMatch(/foreman test\s+◇ watching/);
});
it.each([140, 100, 80])(
  "shows the acting note only when it fits at %i columns, before dropping defaults",
  (columns) => {
    const header = plain(frame(model({ ...watching, chip: answering.chip }, columns))).split(
      "\n",
    )[0];
    expect(header).toContain("◆ acting");
    expect(header).toContain("gpt-6.1-sol");
    if (columns === 140)
      expect(header).toContain("daemon stays up while this monitor is open · w to watch only");
    else expect(header).not.toContain("daemon stays up");
  },
);
it.each([confirming, answering])(
  "centres a framed overlay at wide and standard sizes: $confirm.title$answer.title",
  (act) => {
    for (const [columns, rows] of [
      [140, 40],
      [80, 24],
    ] as const) {
      const output = plain(frame(model(act, columns, rows)));
      const lines = output.split("\n");
      const top = lines.findIndex((line) => line.includes("╭"));
      const bottom = lines.findIndex((line) => line.includes("╰"));
      const heading = lines[top] ?? "";
      const left = heading.indexOf("╭");
      const right = heading.indexOf("╮");
      expect(left).toBeGreaterThan(0);
      expect(Math.abs(left - (columns - right - 1))).toBeLessThanOrEqual(1);
      expect(Math.abs(top - (rows - bottom - 1))).toBeLessThanOrEqual(2);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      if (act.answer) {
        expect(output).toContain("Your answer");
        const bodyText = lines
          .filter((line) => line.includes("│"))
          .map((line) => line.slice(left + 2, right - 1).trim())
          .join(" ")
          .replace(/\s+/g, " ");
        expect(bodyText).toContain("First answer wins.");
        expect(bodyText).toContain(answer.question);
        expect(heading).toContain("waited 3m");
      }
    }
  },
);
it.each([confirming, answering])(
  "keeps overlay frames, title and keys legible with NO_COLOR",
  (act) => {
    const output = frame(model(act, 80, 24), true);
    expect(output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:38|48);`));
    expect(output).toContain("\u001b[1m");
    expect(plain(output)).toContain(act.answer?.title ?? act.confirm?.title);
    expect(plain(output)).toContain("╰");
    expect(plain(output)).toContain("esc cancel");
  },
);
it("uses overlay hints and keeps list and compact footers", () => {
  expect(
    plain(frame(model(answering)))
      .split("\n")
      .at(-1),
  ).toContain("enter send  ctrl-d defer  esc cancel");
  expect(plain(frame(model())).split("\n").at(-1)).toContain("a answer  d defer  ! needs me");
  expect(
    plain(frame(model(watching, 80, 23)))
      .split("\n")
      .at(-1)
      ?.trim(),
  ).toBe("? help  q quit");
});
it.each([true, false])("shows notice ok=%s above the footer in its outcome tone", (ok) => {
  const output = frame(model({ ...watching, notice: { ok, text: "fixture outcome", at: now } }));
  expect(plain(output).split("\n").at(-2)?.trim()).toBe(`${ok ? "✓" : "×"} fixture outcome`);
  expect(output).toContain(ok ? "38;2;92;201;138m" : "38;2;255;122;112m");
});
it("lists answer, defer, watching and needs-me keys in help", () => {
  const output = plain(frame({ ...model(), overlay: true }));
  for (const text of ["a answer", "d defer", "w watch", "! needs me"])
    expect(output).toContain(text);
});
it.each([false, true])(
  "covers the populated list or detail beneath the answer box (detail=%s)",
  (detail) => {
    let state = reduce(
      initialState({
        group: "/repo",
        defaults,
        version: "test",
        now,
        columns: 80,
        rows: 24,
        ...(detail ? { name: run().name } : {}),
      }),
      {
        type: "feed",
        value: live(
          Array.from({ length: 12 }, (_, index) =>
            run(`run-${index}`, {
              activity: { kind: "message", text: "Z".repeat(150), since: at() },
            }),
          ),
        ),
      },
    );
    if (detail)
      state = reduce(state, { type: "detail-feed", name: run().name, value: detailLive() });
    const output = plain(frame({ ...view(state), act: answering }));
    const lines = output.split("\n");
    const top = lines.findIndex((line) => line.includes(answer.title));
    const bottom = lines.findIndex((line, index) => index > top && line.includes("╰"));
    const left = (lines[top] ?? "").indexOf("╭");
    const right = (lines[top] ?? "").indexOf("╮");
    const inside = lines
      .slice(top + 1, bottom)
      .map((line) => line.slice(left + 1, right))
      .join("\n");
    expect(inside).not.toContain("ZZ");
    expect(inside).not.toContain("Read the repo.");
    expect(output).toContain("Your answer");
  },
);
it("types q, j and a into the controlled draft and submits Enter without list keys", async () => {
  let value = model({ ...answering, answer: { ...answer, draft: "" } });
  const keys: string[] = [];
  const messages: ActMessage[] = [];
  const props = () => ({
    model: value,
    colors: theme(0),
    onKey: (key: string) => keys.push(key),
    onTick: () => {},
    onAct: (message: ActMessage) => {
      messages.push(message);
      if (message.type === "draft") {
        value = { ...value, act: { ...value.act, answer: { ...answer, draft: message.text } } };
        app.rerender(createElement(MonitorApp, props()));
      }
    },
  });
  const app = render(createElement(MonitorApp, props()));
  await expect.poll(() => app.lastFrame()).toContain("Your answer");
  app.stdin.write("\u0013");
  await expect.poll(() => keys).toEqual(["ctrl-s"]);
  for (const key of ["q", "j", "a"]) {
    app.stdin.write(key);
    await expect
      .poll(() => messages.at(-1))
      .toEqual({
        type: "draft",
        text: ["q", "j", "a"].slice(0, ["q", "j", "a"].indexOf(key) + 1).join(""),
      });
  }
  app.stdin.write("\r");
  await expect.poll(() => keys).toEqual(["ctrl-s", "enter"]);
  expect(messages).toEqual([
    { type: "draft", text: "q" },
    { type: "draft", text: "qj" },
    { type: "draft", text: "qja" },
  ]);
});
it("routes ctrl-d, ctrl-s, Escape and ctrl-c without inserting them into a draft", async () => {
  const keys: string[] = [];
  const messages: ActMessage[] = [];
  const app = render(
    createElement(MonitorApp, {
      model: model(answering),
      colors: theme(0),
      onKey: (key) => keys.push(key),
      onAct: (message) => messages.push(message),
      onTick: () => {},
    }),
  );
  await expect.poll(() => app.lastFrame()).toContain("Your answer");
  for (const [index, key] of ["\u0004", "\u0013", "\u001b", "\u0003"].entries()) {
    app.stdin.write(key);
    await expect.poll(() => keys.length).toBe(index + 1);
  }
  await expect.poll(() => keys).toEqual(["ctrl-d", "ctrl-s", "escape", "ctrl-c"]);
  expect(messages).toEqual([]);
});
it.each(["sending", "resolved"] as const)(
  "disables sending for an answer that is %s",
  async (flag) => {
    const keys: string[] = [];
    const messages: ActMessage[] = [];
    const app = render(
      createElement(MonitorApp, {
        model: model({
          ...answering,
          hints: [{ key: "esc", label: "cancel" }],
          answer: { ...answer, [flag]: true },
        }),
        colors: theme(0),
        onKey: (key) => keys.push(key),
        onAct: (message) => messages.push(message),
        onTick: () => {},
      }),
    );
    await expect
      .poll(() => app.lastFrame())
      .toContain(
        flag === "sending" ? "sending…" : "q2 was resolved while you typed; your draft is kept",
      );
    if (flag === "sending") app.stdin.write("q");
    app.stdin.write("\r");
    app.stdin.write("\u0003");
    await expect.poll(() => keys).toEqual(["ctrl-c"]);
    expect(messages).toEqual([]);
    expect(plain(app.lastFrame() ?? "")).not.toContain("enter send");
  },
);
