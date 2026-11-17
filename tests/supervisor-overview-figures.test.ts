import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import * as Store from "../src/core/runs/store";
import { RunName, type RunRecord } from "../src/schemas/daemon";
import { PACE_MINUTES } from "../src/schemas/monitor";
import { projectRun } from "../src/supervisor/overview";
import { makeRegistry } from "../src/supervisor/registry";

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const dir = `${home}/runs/unit`;
  yield* fs.makeDirectory(dir, { recursive: true });
  const at = DateTime.makeUnsafe(0);
  const record: RunRecord = {
    name: Schema.decodeUnknownSync(RunName)("unit"),
    threadId: null,
    group: "/repo",
    worktree: "/repo/work/unit",
    baseCommit: "base",
    model: "model",
    effort: "high",
    tier: "priority",
    sandbox: "read-only",
    questionTimeoutMs: 1000,
    state: "idle",
    turns: 1,
    turnKind: "start",
    activeTurnId: null,
    turnBudgetMs: null,
    turnStartedAt: at,
    restoreSandbox: false,
    tokens: null,
    failure: null,
    warnings: [],
    createdAt: at,
    updatedAt: at,
  };
  yield* Store.writeRun(dir, record);
  const registry = yield* makeRegistry(home);
  return { fs, home, registry, run: yield* registry.lookup(record.name) };
});

const command = (exitCode: number | null) => ({
  _tag: "Command" as const,
  command: "check",
  status: exitCode === null ? "failed" : "completed",
  exitCode,
  outputTail: "",
});

it.effect("counts three finished commands and one failure, excluding an open command", () =>
  Effect.gen(function* () {
    const { registry, run } = yield* fixture();
    const before = registry.version;
    for (const exit of [0, 1, 0, null]) yield* registry.event(run, command(exit));
    expect(projectRun(run, "repo", 0).commands).toEqual({ total: 3, failed: 1 });
    expect(registry.version).toBeGreaterThan(before);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("counts distinct FileChange paths across repeated writes", () =>
  Effect.gen(function* () {
    const { registry, run } = yield* fixture();
    const before = registry.version;
    for (const paths of [["a.ts"], ["a.ts", "b.ts"]])
      yield* registry.event(run, { _tag: "FileChange", paths });
    expect(projectRun(run, "repo", 0).filesWritten).toBe(2);
    expect(registry.version).toBeGreaterThan(before);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("recovers the command and file figures after a registry restart", () =>
  Effect.gen(function* () {
    const { registry, run, home } = yield* fixture();
    for (const exit of [0, 1, null]) yield* registry.event(run, command(exit));
    yield* registry.event(run, { _tag: "FileChange", paths: ["a.ts", "a.ts", "b.ts"] });
    yield* registry.state(run, "running");
    const before = projectRun(run, "repo", 0);
    const recovered = yield* makeRegistry(home);
    const loaded = yield* recovered.lookup(run.record.name);
    expect(loaded.record.state).toBe("lost");
    expect(projectRun(loaded, "repo", 0)).toMatchObject({
      commands: { total: 2, failed: 1 },
      filesWritten: 2,
    });
    expect(projectRun(loaded, "repo", 0).commands).toEqual(before.commands);
    expect(projectRun(loaded, "repo", 0).filesWritten).toEqual(before.filesWritten);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports zero figures and twelve zero buckets without a journal", () =>
  Effect.gen(function* () {
    const { fs, run } = yield* fixture();
    expect(yield* fs.exists(`${run.dir}/events.jsonl`)).toBe(false);
    expect(projectRun(run, "repo", 0)).toMatchObject({
      commands: { total: 0, failed: 0 },
      filesWritten: 0,
      pace: Array(PACE_MINUTES).fill(0),
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps unreadable journal figures unknown after recovery and later appends", () =>
  Effect.gen(function* () {
    const { fs, home, run } = yield* fixture();
    yield* fs.writeFileString(`${run.dir}/events.jsonl`, "broken complete line\n");
    const registry = yield* makeRegistry(home);
    const loaded = yield* registry.lookup(run.record.name);
    expect(projectRun(loaded, "repo", 0)).toMatchObject({ commands: null, filesWritten: null });
    yield* fs.writeFileString(`${run.dir}/events.jsonl`, "");
    yield* registry.event(loaded, command(0));
    expect(projectRun(loaded, "repo", 0)).toMatchObject({ commands: null, filesWritten: null });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serves cached figures without reopening the journal", () =>
  Effect.gen(function* () {
    const { fs, registry, run } = yield* fixture();
    yield* registry.event(run, command(0));
    yield* registry.event(run, { _tag: "FileChange", paths: ["a.ts"] });
    yield* fs.remove(`${run.dir}/events.jsonl`);
    yield* fs.makeDirectory(`${run.dir}/events.jsonl`);
    expect(projectRun(run, "repo", 0)).toMatchObject({
      commands: { total: 1, failed: 0 },
      filesWritten: 1,
      pace: [...Array(PACE_MINUTES - 1).fill(0), 2],
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports who interrupted an interrupted run, and survives a registry restart", () =>
  Effect.gen(function* () {
    const { home, registry, run } = yield* fixture();
    expect(projectRun(run, "repo", 0).interruptedBy).toBeNull();
    yield* registry.event(run, { _tag: "Interrupted", by: "monitor" });
    yield* registry.state(run, "interrupted");
    expect(projectRun(run, "repo", 0).interruptedBy).toBe("monitor");
    const recovered = yield* makeRegistry(home);
    const loaded = yield* recovered.lookup(run.record.name);
    expect(loaded.record.state).toBe("interrupted");
    expect(projectRun(loaded, "repo", 0).interruptedBy).toBe("monitor");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("drops the interruption cause once the run moves on", () =>
  Effect.gen(function* () {
    const { registry, run } = yield* fixture();
    yield* registry.event(run, { _tag: "Interrupted", by: "orchestrator" });
    yield* registry.state(run, "interrupted");
    yield* registry.state(run, "running");
    expect(projectRun(run, "repo", 0).interruptedBy).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);
