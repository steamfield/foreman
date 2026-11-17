import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import type { ActMessage, ActView } from "../src/core/monitor/act";
import { initialState, reduce, type ViewModel, view } from "../src/core/monitor/model";
import { MonitorApp, Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, detailLive, now, run } from "./helpers/monitor";

afterEach(cleanup);
const watching: ActView = {
  chip: { mode: "watching", text: "◇ watching" },
  confirm: null,
  compose: null,
  answer: null,
  notice: null,
  hints: null,
};
const answer: NonNullable<ActView["answer"]> = {
  context: [],
  title: "■ answer  fix-hooks q2",
  meta: "waited 3m · defers in 12m",
  question: "Keep the existing hook API?",
  draft: "Keep the signature.",
  sending: false,
  resolved: false,
  alsoWaiting: "Also waiting  The delegating session.",
};
const answering: ActView = { ...watching, chip: { mode: "acting", text: "◆ acting" }, answer };
function model(act: ActView, columns: number, rows: number): ViewModel {
  return {
    ...view(initialState({ group: "/repo", defaults, version: "test", now, columns, rows })),
    act,
    message: [],
    animating: false,
  };
}
function frame(value: ViewModel) {
  return renderToString(createElement(Screen, { model: value, colors: theme(0) }), {
    columns: value.columns,
  });
}
const plain = stripVTControlCharacters;

it("keeps long draft edits and the caret visible after the third row", async () => {
  const draft = `${"Keep the API stable. ".repeat(25)}visible tail`;
  let current = model(
    {
      ...answering,
      answer: {
        ...answer,
        draft,
      },
    },
    80,
    24,
  );
  const messages: ActMessage[] = [];
  const props = () => ({
    model: current,
    colors: theme(0),
    onKey: () => {},
    onTick: () => {},
    onAct: (message: ActMessage) => {
      messages.push(message);
      if (message.type === "draft") {
        current = {
          ...current,
          act: { ...current.act, answer: { ...answer, draft: message.text } },
        };
        app.rerender(createElement(MonitorApp, props()));
      }
    },
  });
  const app = render(createElement(MonitorApp, props()));
  await expect.poll(() => plain(app.lastFrame() ?? "")).toContain("visible tail");
  app.stdin.write("!");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({
      type: "draft",
      text: `${draft}!`,
    });
  await expect.poll(() => plain(app.lastFrame() ?? "")).toContain("visible tail!");
});
it("caps a long question at 80x24 with an ellipsis and keeps the input and actions framed", async () => {
  const app = render(
    createElement(Screen, {
      model: model(
        {
          ...answering,
          answer: { ...answer, question: "A long question with context. ".repeat(150) },
        },
        80,
        24,
      ),
      colors: theme(0),
    }),
  );
  await expect.poll(() => plain(app.lastFrame() ?? "")).toContain("Your answer");
  await expect
    .poll(() =>
      plain(app.lastFrame() ?? "")
        .split("\n")
        .some((line) => /│\s+…\s+│/.test(line)),
    )
    .toBe(true);
  const lines = plain(app.lastFrame() ?? "").split("\n");
  expect(lines).toHaveLength(24);
  expect(lines.some((line) => /│\s+…\s+│/.test(line))).toBe(true);
  expect(lines.some((line) => line.includes("enter send") && line.includes("│"))).toBe(true);
  expect(lines.some((line) => line.includes("╰") && line.includes("╯"))).toBe(true);
});
it("closes the frame for a maximum-length answer title at 80 columns", () => {
  const output = plain(
    frame(
      model(
        { ...answering, answer: { ...answer, title: `■ answer  ${"r".repeat(64)} q2`, meta: "" } },
        80,
        24,
      ),
    ),
  );
  expect(output.split("\n").find((line) => line.includes("╭"))).toMatch(/….*╮\s*$/);
});
it("keeps the quit label in the narrow detail footer", () => {
  const state = reduce(
    initialState({
      group: "/repo",
      defaults,
      version: "test",
      now,
      columns: 70,
      rows: 40,
      name: run().name,
    }),
    { type: "detail-feed", name: run().name, value: detailLive() },
  );
  expect(
    plain(frame({ ...view(state), act: watching }))
      .split("\n")
      .at(-1),
  ).toContain("q quit");
});
