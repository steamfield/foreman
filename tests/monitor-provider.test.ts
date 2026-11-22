import { stripVTControlCharacters } from "node:util";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import chalk from "chalk";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { renderToString } from "ink";
import { createElement } from "react";
import { detailHeader } from "../src/core/monitor/detail-facts";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { diskRunView } from "../src/core/runs/disk-overview";
import * as Store from "../src/core/runs/store";
import { RunName, type RunRecord } from "../src/schemas/daemon";
import type { RunView } from "../src/schemas/monitor";
import { projectRun } from "../src/supervisor/overview";
import { makeRegistry } from "../src/supervisor/registry";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, detail, live, now, run } from "./helpers/monitor";

const agy = (name: string, model: string, effort: string) =>
  run(name, { provider: "agy", model, effort });
const neon = agy("neon", "gemini-4-neon", "high");
const flash = agy("flash", "gemini-3.8-flash", "low");
const fixed = agy("fixed", "claude-opus-4-7", "none");
const state = (runs: readonly RunView[], columns: number) =>
  reduce(initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 40 }), {
    type: "feed",
    value: live(runs),
  });
const rendered = (runs: readonly RunView[], columns: number) => {
  const previous = chalk.level;
  chalk.level = 0;
  try {
    return stripVTControlCharacters(
      renderToString(
        createElement(Screen, { model: view(state(runs, columns)), colors: theme(3, true) }),
        { columns },
      ),
    ).split("\n");
  } finally {
    chalk.level = previous;
  }
};
const modelFact = (data: RunView) =>
  detailHeader(state([data], 140), detail(data), "live").find(([label]) => label === "model")?.[1];

describe("monitor provider tag", () => {
  it.each([90, 100, 140])(
    "keeps the tag and effort visible in the rendered model cell at %i columns",
    (columns) => {
      const lines = rendered([neon, flash, fixed, run("codex")], columns);
      const row = (name: string) => lines.find((line) => line.includes(` ${name} `)) ?? "";
      expect(row("neon")).toContain("agy 4-n… · high ");
      expect(row("flash")).toContain("agy 3.8-… · low ");
      expect(row("fixed")).toContain("agy claude-opu… ");
      expect(row("fixed")).not.toContain("none");
      expect(row("codex")).toContain("sol · high ");
    },
  );

  it("drops the model column, and the tag with it, below 90 columns", () => {
    const lines = rendered([neon], 80);
    expect(lines.join("\n")).not.toMatch(/agy|4-ne|MODEL/);
  });

  it("names the provider first on the agy detail model fact and omits effort none", () => {
    expect(modelFact(neon)).toBe("agy · gemini-4-neon · high");
    expect(modelFact(fixed)).toBe("agy · claude-opus-4-7");
    expect(modelFact(run())).toBe("gpt-6.1-sol · high · priority");
  });
});

const record = (provider?: "agy"): RunRecord => ({
  name: Schema.decodeUnknownSync(RunName)("unit"),
  ...(provider ? { provider } : {}),
  threadId: null,
  group: "/repo",
  worktree: "/repo/work",
  baseCommit: "base",
  model: "model",
  effort: "high",
  tier: "priority",
  sandbox: "read-only",
  questionTimeoutMs: 1000,
  state: "idle",
  turns: 0,
  turnKind: null,
  activeTurnId: null,
  turnBudgetMs: null,
  turnStartedAt: null,
  restoreSandbox: false,
  tokens: null,
  failure: null,
  warnings: [],
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
});

describe("overview builders", () => {
  it.effect.each([
    ["agy", "agy"],
    [undefined, undefined],
  ] as const)("carry provider %s from the run record in live and saved views", ([stored, shown]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const dir = `${home}/runs/unit`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* Store.writeRun(dir, record(stored));
      const registry = yield* makeRegistry(home);
      const liveView = projectRun(yield* registry.lookup(record().name), "repo", 1);
      const savedView = yield* diskRunView(dir, record(stored));
      expect(liveView.provider).toBe(shown);
      expect(savedView.provider).toBe(shown);
      expect("provider" in liveView).toBe(shown !== undefined);
      expect("provider" in savedView).toBe(shown !== undefined);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
