import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { detailHeader } from "../src/core/monitor/detail-facts";
import { initialState, reduce, view } from "../src/core/monitor/model";
import { diskRunView } from "../src/core/runs/disk-overview";
import * as Store from "../src/core/runs/store";
import { RunName, type RunRecord } from "../src/schemas/daemon";
import type { RunView } from "../src/schemas/monitor";
import { projectRun } from "../src/supervisor/overview";
import { makeRegistry } from "../src/supervisor/registry";
import { defaults, detail, live, now, run } from "./helpers/monitor";

const agyRun = (overrides: Partial<RunView> = {}) =>
  run("agy-run", {
    provider: "agy",
    model: "gemini-3.8-flash-low",
    effort: "medium",
    ...overrides,
  });
const labels = (runs: readonly RunView[], columns: number) =>
  view(
    reduce(initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 40 }), {
      type: "feed",
      value: live(runs),
    }),
  ).groups.flatMap((group) => group.rows.map((row) => row.modelLabel));
const modelFact = (data: RunView, columns: number) => {
  const state = initialState({ group: "/repo", defaults, version: "test", now, columns, rows: 40 });
  return detailHeader(state, detail(data), "live").find(([label]) => label === "model")?.[1];
};

describe("monitor provider tag", () => {
  it.each([80, 100, 140])(
    "leads an agy row's model label with the tag at %i columns",
    (columns) => {
      expect(labels([agyRun()], columns)).toEqual(["agy gemini-3.8-flash-low · med"]);
    },
  );

  it.each([80, 140])("leaves a Codex row's label unchanged at %i columns", (columns) => {
    expect(labels([run("plain"), run("explicit", { provider: "codex" })], columns)).toEqual([
      "sol · high",
      "sol · high",
    ]);
  });

  it("names the provider on an agy detail model fact and keeps Codex facts as they were", () => {
    expect(modelFact(agyRun(), 80)).toBe("agy · gemini-3.8-flash-low · medium");
    expect(modelFact(agyRun(), 140)).toBe("agy · gemini-3.8-flash-low · medium");
    expect(modelFact(run(), 140)).toBe("gpt-6.1-sol · high · priority");
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
