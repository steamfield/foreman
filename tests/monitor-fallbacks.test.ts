import { stripVTControlCharacters as plain } from "node:util";
import { renderToString } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { expect, it } from "vitest";
import type { MonitorFeed } from "../src/core/monitor/feed";
import { initialState, reduce, view } from "../src/core/monitor/model";
import type { ViewModel } from "../src/core/monitor/model-types";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import {
  at,
  defaults,
  detail,
  inspectStart,
  live,
  mixedRuns,
  now,
  run,
  subagents,
} from "./helpers/monitor";

const saved: MonitorFeed = {
  _tag: "Saved",
  reason: "no-daemon",
  overview: { _tag: "Overview", daemon: null, runs: [] },
  receivedAt: now - 2000,
  nextProbeAt: now + 7000,
};
function state(feed = live([]), columns = 100) {
  return reduce(
    initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 24 }),
    { type: "feed", value: feed },
  );
}
function frame(model: ViewModel, noColor = false) {
  return renderToString(createElement(Screen, { model, colors: theme(3, noColor) }), {
    columns: model.columns,
  });
}
const meanings = [
  "⣾  running    a turn is executing; the second line says what it is doing",
  "■  waiting    Codex asked a question and needs a person",
  "✓  done       the turn finished; review it, then archive",
  "×  failed     the turn ended with an error",
];
it("introduces first runs in board order and counts down the next daemon probe at 100x24", () => {
  const current = state(saved);
  const output = plain(frame(view(current)));
  const content = [
    "No runs on this machine yet.",
    "Runs are started by your coding agent. Ask it to delegate, for example:",
    "“Use foreman to have Codex fix the flaky hook test.”",
    "Check this repo is ready     foreman doctor",
    "Teach your agent foreman     foreman skill install",
    "What you will see here",
    ...meanings,
    "━━━─── budget     time used of the turn's limit, not progress",
    "This screen updates by itself. Checking for a daemon again in 7s.",
  ];
  let last = -1;
  for (const text of content) {
    const index = output.indexOf(text);
    expect(index, text).toBeGreaterThan(last);
    last = index;
  }
  expect(output.split("\n")).toHaveLength(24);
  expect(output).toContain("no daemon · showing saved runs");
  expect(frame(view(current))).toContain(
    theme(3).paint("no daemon · showing saved runs", "interrupted"),
  );
  expect(view(current).animating).toBe(true);
  expect(plain(frame(view(reduce(current, { type: "tick", now: now + 1000 }))))).toContain(
    "again in 6s.",
  );
});
it("introduces first runs with a live daemon without a probe countdown", () => {
  const output = plain(frame(view(state())));
  for (const text of [
    "No runs on this machine yet.",
    "foreman doctor",
    "foreman skill install",
    ...meanings,
  ])
    expect(output).toContain(text);
  expect(output).not.toContain("Checking for a daemon");
  expect(output).not.toContain("foreman start");
});
it("keeps counting down repeated saved-state probes when unchanged content emits no new feed value", () => {
  const current = state(saved);
  for (const elapsed of [11000, 21000]) {
    const next = reduce(current, { type: "tick", now: now + elapsed });
    expect(plain(frame(view(next)))).toContain("Checking for a daemon again in 6s.");
  }
});
it("shows the same glyph meanings in first run and help and lists all v1 key groups", () => {
  const current = state();
  const help = plain(frame(view(reduce(current, { type: "key", key: "?" }))));
  const first = plain(frame(view(current)));
  for (const text of meanings) {
    expect(first).toContain(text);
    expect(help).toContain(text);
  }
  for (const text of [
    "a answer",
    "d defer",
    "s steer",
    "F follow up",
    "i interrupt",
    "x archive",
    "ctrl-e",
    "ctrl-s",
    "w watch",
    "/ filter",
    ": palette",
    "g group",
    "h history",
    "! needs me",
    "d diff",
    "D $PAGER",
    "r reviewed",
    "1-5 feed",
    "n/p hunk",
    "f follow",
    "copy command",
    "foreman status --all",
  ])
    expect(help).toContain(text);
});
function attention(columns: number) {
  return state(
    live([
      run("fix-hooks", {
        state: "waiting",
        questions: mixedRuns()[0]?.questions ?? [],
        subagents: subagents(2),
      }),
      run("lint-sweep", {
        state: "failed",
        stateSince: at(-480000),
        failure: { message: "bun run check exited 1", hint: null },
      }),
      run("migrate-config", { turnStartedAt: at(-3240000) }),
      run("rename-flags", { state: "idle", filesWritten: 2 }),
    ]),
    columns,
  );
}
it("uses heavy question frames, uppercase attention and only weight and inverse escapes in NO_COLOR at 100x24", () => {
  const output = frame(view(attention(100)), true);
  const text = plain(output);
  for (const label of [
    "┏━ ■ WAITING",
    "┃ Keep the existing hook API?",
    "┗━",
    "FAILED",
    "90% OF BUDGET",
    "× lint-sweep",
    "▲ migrate-config",
    "q2 pending",
  ])
    expect(text).toContain(label);
  expect(output).toContain("\u001b[7m");
  // Spec 3.7: under NO_COLOR, glyphs and weight carry meaning, so bold and inverse are the only escapes.
  const weightAndInverse = new RegExp(`${String.fromCharCode(27)}\\[(?:1|22|7|27)m`, "g");
  expect(output.replace(weightAndInverse, "")).toBe(text);
});
it("compacts notes, pinned rows, flags, subagents and freshness into the 80x24 board", () => {
  const output = plain(frame(view(attention(80))));
  const lines = output.split("\n");
  expect(lines).toHaveLength(24);
  const heading = lines.findIndex((line) => line.includes("╭─ ■"));
  expect(lines[heading + 1]).toContain("Keep the existing hook API?");
  expect(lines[heading + 2]).toMatch(/╰ a answer ─+╯/);
  expect(output).not.toContain("foreman answer");
  expect(output).toContain("× lint-sweep failed 8m  ▲ migrate-config 90% budget");
  expect(output).toContain(" · 2 subagents");
  expect(output).not.toContain("child-00");
  for (const [name, flag] of [
    ["fix-hooks", "q2"],
    ["rename-flags", "review"],
    ["migrate-config", "90%"],
  ]) {
    const row = lines.find(
      (line) =>
        line.includes(name ?? "") && /waiting|idle|running/.test(line) && !line.includes("╭"),
    );
    expect(row?.trimEnd()).toMatch(new RegExp(`${flag}$`));
  }
  expect(lines.at(-1)?.trimEnd()).toMatch(
    /^⏎ open {2}a answer {2}\/ filter {2}: palette {2}\? help {2}q quit +0\.0s$/,
  );
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
});

it("keeps the no-daemon header visible above populated saved runs", () => {
  const current = state({
    ...saved,
    overview: { _tag: "Overview", daemon: null, runs: mixedRuns() },
  });
  expect(plain(frame(view(current))).split("\n")[0]).toContain("no daemon · showing saved runs");
});
it("keeps other-repo supervision guidance in a compact question note", () => {
  const other = mixedRuns().find((run) => run.group === "/other");
  if (!other) throw new Error("Expected another repository's pending question");
  const output = plain(frame(view(state(live([other]), 80))));
  expect(output).toContain("other repo: its own session supervises it");
  expect(output).not.toContain("╰ a answer");
});
it("keeps attention words uppercase when monochrome and narrow layouts combine", () => {
  const output = plain(frame(view(attention(80)), true));
  expect(output).toContain("lint-sweep FAILED 8m");
  expect(output).toContain("migrate-config 90% OF BUDGET");
  expect(output.split("\n")[0]).toContain("1 WAITING");
});
it("keeps both compact attention reasons visible when a failed run has a maximum-length name", () => {
  const name = `failed-${"x".repeat(57)}`;
  const current = state(
    live([
      run(name, { state: "failed", stateSince: at(-480000) }),
      run("migrate-config", { turnStartedAt: at(-3240000) }),
    ]),
    80,
  );
  const lines = plain(frame(view(current))).split("\n");
  const pins = lines.find((line) => line.startsWith("×")) ?? "";
  expect(pins).toContain("× failed-");
  expect(pins).toContain("… failed 8m");
  expect(pins).toContain("▲ migrate-config 90% budget");
  expect(stringWidth(pins)).toBeLessThanOrEqual(80);
});

const long = "wide 界 ".repeat(50);
function overlay(kind: string): ViewModel {
  const base = view(state(live([run()]), 80));
  if (kind === "answer")
    return {
      ...base,
      act: {
        ...base.act,
        answer: {
          title: "■ answer fix-hooks q2",
          meta: long,
          context: [{ text: long, tone: "fg" }],
          question: long,
          draft: long,
          sending: false,
          resolved: false,
          alsoWaiting: "First answer wins.",
        },
      },
    };
  if (kind === "compose")
    return {
      ...base,
      act: {
        ...base.act,
        compose: { title: "Steer fix-hooks", meta: long, draft: long, sending: false },
      },
    };
  if (kind === "confirm")
    return {
      ...base,
      act: {
        ...base.act,
        confirm: {
          title: "Interrupt fix-hooks?",
          lines: [long],
          keys: [
            { key: "y", label: "interrupt" },
            { key: "esc", label: "cancel" },
          ],
        },
      },
    };
  if (kind === "palette")
    return {
      ...base,
      palette: {
        query: "",
        subject: long,
        items: [{ label: long, detail: long, key: "a", selected: true, heading: false }],
      },
    };
  if (kind === "history")
    return {
      ...base,
      history: {
        status: "ready",
        message: null,
        selected: 0,
        offset: 0,
        rows: [
          {
            name: "archived-run",
            repo: long,
            task: long,
            outcome: "done",
            tone: "done",
            ended: "1h ago",
            duration: "12m",
            turns: 2,
            tokens: "12k",
            archived: true,
          },
        ],
      },
    };
  const inspected = view({
    ...inspectStart(detail(run("finished", { state: "idle" }))),
    columns: 80,
    rows: 24,
  });
  const diff = {
    title: "src/long-path.ts",
    position: "1 of 1",
    status: "ready" as const,
    message: null,
    lines: [
      { text: `+${long}`, kind: "add" as const, oldLine: null, newLine: 1 },
      { text: `−${long}`, kind: "remove" as const, oldLine: 1, newLine: null },
    ],
    offset: 0,
    truncated: false,
  };
  if (kind === "diff") return { ...inspected, diff };
  return {
    ...inspected,
    diff,
    review: {
      focus: "handoff",
      filesMessage: null,
      lateAnswerHint: "a answer",
      summary: "done",
      reviewed: false,
      handoff: { title: "Hand-off", lines: [long] },
      decided: [],
      files: [
        { path: long, status: "M", added: "+1", removed: "−1", outside: true, selected: true },
      ],
      filesNote: long,
    },
  };
}
it.each(["answer", "compose", "confirm", "palette", "history", "diff", "review"])(
  "keeps the %s overlay inside 80x24 with long and wide text",
  (kind) => {
    const text = plain(frame(overlay(kind), true));
    const lines = text.split("\n");
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(stringWidth(line), line).toBeLessThanOrEqual(80);
    expect(text).toContain(
      {
        answer: "Your answer",
        compose: "Steer fix-hooks",
        confirm: "Interrupt fix-hooks?",
        palette: "Commands",
        history: "archived-run",
        diff: "src/long-path.ts",
        review: "Hand-off",
      }[kind] ?? "",
    );
    if (kind === "confirm") expect(text).toContain("y interrupt");
    if (kind === "answer" || kind === "compose") expect(text).toContain("enter send");
  },
);
