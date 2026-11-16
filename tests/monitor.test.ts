import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Clock, DateTime, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { replay } from "../scripts/quiet-replay";
import {
  activity,
  defersAt,
  firstProseLine,
  handoffLine,
  QUIET_AFTER_MS,
  type QuestionCacheEntry,
  quiet,
  shellCommand,
  type TurnAttention,
  updateQuestion,
  updateTurnAttention,
} from "../src/core/monitor/attention";
import { renderOverview } from "../src/core/monitor/status-all";
import * as Store from "../src/core/runs/store";
import * as D from "../src/schemas/daemon";
import { Overview } from "../src/schemas/monitor";
import { detail } from "../src/supervisor/detail";
import { overview, projectRun } from "../src/supervisor/overview";
import { makeRegistry } from "../src/supervisor/registry";

const q1 = Schema.decodeUnknownSync(D.QuestionId)("q1");
const at = DateTime.makeUnsafe(1000);
const asked: Extract<D.QuestionLine, { _tag: "Asked" }> = {
  _tag: "Asked",
  id: q1,
  turn: 1,
  kind: "blocked",
  question: "Which path?",
  at,
};
const metadata = { version: "test", build: "test", startedAt: at };

const fixture = Effect.fnUntraced(function* (count = 1) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  for (let i = 0; i < count; i++) {
    const name = Schema.decodeUnknownSync(D.RunName)(`run-${i}`);
    const dir = `${home}/runs/${name}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    const record: D.RunRecord = {
      name,
      threadId: "thread",
      group: "/repo",
      worktree: "/repo/work",
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
      turnBudgetMs: 60000,
      turnStartedAt: at,
      restoreSandbox: false,
      tokens: null,
      failure: null,
      warnings: [],
      createdAt: at,
      updatedAt: at,
    };
    yield* Store.writeRun(dir, record);
    yield* fs.writeFileString(`${dir}/contract.md`, "# Test task");
  }
  const registry = yield* makeRegistry(home);
  const run = [...registry.runs.values()][0];
  assert.isDefined(run);
  return { fs, home, registry, run };
});

describe("monitor attention", () => {
  it("ends an unfinished replay command when its parent turn completes", () => {
    const journal = [
      { at: new Date(0).toISOString(), event: { _tag: "TurnStarted" } },
      { at: new Date(360000).toISOString(), event: { _tag: "TurnCompleted" } },
      { at: new Date(420000).toISOString(), event: { _tag: "TurnStarted" } },
      { at: new Date(1200000).toISOString(), event: { _tag: "TurnCompleted" } },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    const codex = [
      { method: "item/started", params: { item: { type: "commandExecution", startedAtMs: 0 } } },
      { method: "turn/started", params: { turn: { startedAt: 420 } } },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    expect(replay(codex, journal)).toEqual({
      totalMs: 1140000,
      anchoredMs: 1140000,
      quietMs: 480000,
      falsePositiveMs: 0,
      episodes: 1,
      untimedMessages: 0,
      stretches: [{ start: 720000, end: 1200000 }],
    });
  });

  it.each([false, true])(
    "replays timed commands and silence, excluding untimed delta gaps: %s",
    (delta) => {
      const journal = [
        { at: new Date(0).toISOString(), event: { _tag: "StateChanged", to: "running" } },
        { at: new Date(720000).toISOString(), event: { _tag: "TurnCompleted" } },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n");
      const codex = [
        { method: "item/started", params: { item: { type: "commandExecution", startedAtMs: 0 } } },
        {
          method: "item/completed",
          params: { item: { type: "commandExecution", startedAtMs: 0, completedAtMs: 360000 } },
        },
        ...(delta ? [{ method: "item/agentMessage/delta", params: {} }] : []),
        { method: "turn/completed", params: { turn: { completedAt: 720 } } },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n");
      expect(replay(codex, journal)).toEqual({
        totalMs: 720000,
        anchoredMs: delta ? 360000 : 720000,
        quietMs: delta ? 0 : 60000,
        falsePositiveMs: 0,
        episodes: delta ? 0 : 1,
        untimedMessages: delta ? 1 : 0,
        stretches: delta ? [] : [{ start: 660000, end: 720000 }],
      });
    },
  );

  it("marks only running runs without an open command quiet after five minutes", () => {
    expect(quiet("running", null, 0, QUIET_AFTER_MS)).toBe(true);
    expect(
      quiet("running", { type: "reasoning", command: null, startedAt: 0 }, 0, QUIET_AFTER_MS),
    ).toBe(true);
    expect(quiet("running", null, 0, QUIET_AFTER_MS - 1)).toBe(false);
    expect(
      quiet(
        "running",
        { type: "commandExecution", command: "check", startedAt: 0 },
        0,
        QUIET_AFTER_MS,
      ),
    ).toBe(false);
    expect(quiet("waiting", null, 0, QUIET_AFTER_MS)).toBe(false);
    expect(quiet("idle", null, 0, QUIET_AFTER_MS)).toBe(false);
    expect(quiet("running", null, null, QUIET_AFTER_MS)).toBe(false);
  });

  it("computes auto-defer deadlines only until deferral", () => {
    expect(defersAt(100, 1000, false)).toBe(1100);
    expect(defersAt(100, 0, false)).toBe(100);
    expect(defersAt(100, 1000, true)).toBeNull();
  });

  it("selects commands before commentary while active and outcomes or failures when inactive", () => {
    const input = {
      state: "running" as const,
      openItem: { type: "commandExecution", command: "check", startedAt: 1 },
      commentary: { text: "Working", at: 2 },
      handoff: { text: "Done", at: 3 },
      failure: { text: "Failed", at: 4 },
    };
    expect(activity(input)).toEqual({ kind: "command", text: "check", at: 1 });
    expect(activity({ ...input, openItem: null })).toEqual({
      kind: "message",
      text: "Working",
      at: 2,
    });
    expect(activity({ ...input, openItem: { ...input.openItem, type: "reasoning" } })).toEqual({
      kind: "message",
      text: "Working",
      at: 2,
    });
    expect(activity({ ...input, openItem: null, commentary: null })).toBeNull();
    expect(activity({ ...input, state: "idle" })).toEqual({ kind: "outcome", text: "Done", at: 3 });
    for (const state of ["failed", "lost"] as const)
      expect(activity({ ...input, state })).toEqual({ kind: "failure", text: "Failed", at: 4 });
    expect(activity({ ...input, state: "interrupted", handoff: null })).toBeNull();
  });

  it("folds asked, deferred and answered question lines without retaining resolved questions", () => {
    const cache = new Map<D.QuestionId, QuestionCacheEntry>();
    updateQuestion(cache, asked);
    expect([...cache.values()]).toEqual([{ asked, deferred: false }]);
    updateQuestion(cache, { _tag: "Deferred", id: q1, by: "timeout", at });
    expect([...cache.values()]).toEqual([{ asked, deferred: true }]);
    updateQuestion(cache, { _tag: "Resolved", id: q1, resolution: "late", text: "A", at });
    expect(cache.size).toBe(0);
    updateQuestion(cache, asked);
    updateQuestion(cache, { _tag: "Resolved", id: q1, resolution: "answered", text: "B", at });
    expect(cache.size).toBe(0);
  });

  it("keeps the handoff's first line and resets retry and hook attention on a new turn", () => {
    expect(handoffLine("Finished.\r\nDetails", 10)).toEqual({ text: "Finished.", at: 10 });
    // The contract's hand-off template opens with numbered headings.
    expect(handoffLine("1. Summary\n\nBuilt the stage.\n\n2. Files", 10).text).toBe(
      "Built the stage.",
    );
    expect(handoffLine("## Summary\nAdded the flag.", 10).text).toBe("Added the flag.");
    expect(handoffLine("1. Summary: Fixed the parser.\n2. Files", 10).text).toBe(
      "Fixed the parser.",
    );
    expect(handoffLine("\n  \nDone", 10).text).toBe("Done");
    expect(firstProseLine("**1. Summary**\n\nAll four findings are fixed.")).toBe(
      "All four findings are fixed.",
    );
    expect(shellCommand("/bin/zsh -lc 'bun run typecheck'")).toBe("bun run typecheck");
    expect(shellCommand(`/bin/bash -lc "rg -n 'x' src"`)).toBe("rg -n 'x' src");
    expect(shellCommand("bun run lint")).toBe("bun run lint");
    const cache: TurnAttention = { retrying: null, hooksBlocked: 0 };
    updateTurnAttention(cache, { _tag: "Retrying", message: "try again" }, 10);
    updateTurnAttention(cache, { _tag: "Retrying", message: "usage limit" }, 20);
    updateTurnAttention(cache, { _tag: "HookBlocked", event: "PreToolUse", feedback: "scope" }, 20);
    expect(cache).toEqual({ retrying: { message: "usage limit", at: 20 }, hooksBlocked: 1 });
    updateTurnAttention(cache, { _tag: "TurnStarted", turn: 2, kind: "followup" }, 30);
    expect(cache).toEqual({ retrying: null, hooksBlocked: 0 });
    const clearsRetry: D.RunEventBody[] = [
      ...["completed", "failed", "interrupted"].map((status) => ({
        _tag: "TurnCompleted" as const,
        turn: 2,
        status,
        failure: null,
      })),
      { _tag: "Interrupted", by: "orchestrator" },
      { _tag: "StateChanged", from: "running", to: "lost" },
      { _tag: "AgentMessage", text: "Back to work", phase: "commentary" },
      {
        _tag: "Command",
        command: "bun run lint",
        status: "inProgress",
        exitCode: null,
        outputTail: "",
      },
      { _tag: "FileChange", paths: ["src/cli.ts"] },
    ];
    for (const event of clearsRetry) {
      updateTurnAttention(cache, { _tag: "Retrying", message: "try again" }, 40);
      updateTurnAttention(
        cache,
        { _tag: "HookBlocked", event: "PreToolUse", feedback: "scope" },
        40,
      );
      const hooks = cache.hooksBlocked;
      updateTurnAttention(cache, event, 50);
      expect(cache, event._tag).toEqual({ retrying: null, hooksBlocked: hooks });
    }
  });
});

describe("overview projection", () => {
  it.effect("Detail ignores other runs' changes but wakes for its own run and archive", () =>
    Effect.gen(function* () {
      const { registry, run } = yield* fixture(2);
      const other = yield* registry.lookup(Schema.decodeUnknownSync(D.RunName)("run-1"));
      const initial = yield* detail(registry, { _tag: "Detail", name: run.record.name });
      const pending = yield* detail(registry, {
        _tag: "Detail",
        name: run.record.name,
        after: initial.version,
        timeoutMs: 10000,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* registry.event(other, { _tag: "Other", method: "unrelated" });
      yield* TestClock.adjust(1000);
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* registry.handoff(run, "Done");
      yield* TestClock.adjust(250);
      const result = yield* Fiber.join(pending);
      expect(result.version).toBeGreaterThan(initial.version);
      expect(result.handoff).toEqual({ turn: 1, text: "Done" });
      const replaced = yield* detail(registry, {
        _tag: "Detail",
        name: run.record.name,
        after: result.version,
        timeoutMs: 10000,
      }).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1);
      const replacement = yield* registry.add(run.record);
      yield* TestClock.adjust(250);
      expect(replaced.pollUnsafe()).toBeDefined();
      expect(yield* Fiber.join(replaced)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RunNotFound" },
      });
      const archived = yield* detail(registry, {
        _tag: "Detail",
        name: replacement.record.name,
        after: replacement.version,
        timeoutMs: 10000,
      }).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(1);
      yield* registry.archive(run.record.name);
      yield* TestClock.adjust(250);
      expect(yield* Fiber.join(archived)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RunNotFound" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([false, true])(
    "recovers state age for a pending inactive transition (published: %s)",
    (published) =>
      Effect.gen(function* () {
        const { registry, run, home } = yield* fixture();
        yield* TestClock.setTime(2000);
        yield* registry.state(run, "running");
        const id = crypto.randomUUID();
        yield* TestClock.setTime(3000);
        if (published)
          yield* Store.appendEvent(
            run.dir,
            { _tag: "StateChanged", from: "running", to: "idle" },
            id,
          );
        yield* Store.writeRun(run.dir, {
          ...run.record,
          state: "idle",
          pendingStateEvent: { id, from: "running", to: "idle" },
          updatedAt: DateTime.makeUnsafe(4000),
        });
        yield* TestClock.setTime(5000);
        const restarted = yield* makeRegistry(home);
        const loaded = yield* restarted.lookup(run.record.name);
        expect(loaded.record.pendingStateEvent).toBeNull();
        const events = (yield* Store.readEvents(run.dir)).events;
        const transition = events.filter((entry) => entry.transitionId === id);
        expect(transition).toHaveLength(1);
        const expected = DateTime.makeUnsafe(published ? 3000 : 5000);
        expect(transition[0]?.at).toEqual(expected);
        expect(projectRun(loaded, "repo", 5000).stateSince).toEqual(expected);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers state age from the last transition rather than token saves", () =>
    Effect.gen(function* () {
      const { registry, run, home } = yield* fixture();
      yield* TestClock.setTime(2000);
      yield* registry.state(run, "running");
      yield* TestClock.setTime(3000);
      yield* registry.state(run, "idle");
      yield* TestClock.setTime(4000);
      yield* registry.event(run, {
        _tag: "TokenUsage",
        totals: { input: 10, output: 5, cachedInput: 0, reasoningOutput: 0 },
      });
      yield* registry.save(run, {
        tokens: { input: 10, output: 5, cachedInput: 0, reasoningOutput: 0 },
      });
      const reloaded = yield* makeRegistry(home);
      const loaded = yield* reloaded.lookup(run.record.name);
      expect(projectRun(loaded, "repo", 5000).stateSince).toEqual(DateTime.makeUnsafe(3000));
      yield* (yield* FileSystem.FileSystem).writeFileString(`${run.dir}/events.jsonl`, "");
      const noEvents = yield* makeRegistry(home);
      expect((yield* noEvents.lookup(run.record.name)).stateSince).toBe(1000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a recovered run available when its optional handoff cannot be read", () =>
    Effect.gen(function* () {
      const { fs, home, run } = yield* fixture();
      yield* fs.makeDirectory(`${run.dir}/turns/1.md`, { recursive: true });
      const registry = yield* makeRegistry(home);
      const result = yield* overview(registry, metadata, { _tag: "Overview" });
      expect(result.runs).toMatchObject([{ name: run.record.name, activity: null }]);
      expect((yield* registry.lookup(run.record.name)).record.state).toBe("idle");
      expect((yield* registry.archive(run.record.name))._tag).toBe("Archived");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("isolates a damaged question cache during load and still serves healthy runs", () =>
    Effect.gen(function* () {
      const { fs, home, run } = yield* fixture(2);
      yield* fs.writeFileString(`${run.dir}/questions.jsonl`, "broken complete line\n");
      const registry = yield* makeRegistry(home);
      const result = yield* overview(registry, metadata, { _tag: "Overview" });
      expect(result.runs.map((entry) => entry.name)).toEqual(["run-1"]);
      expect(yield* registry.skipped("/repo")).toMatchObject([{ path: run.dir }]);
      expect(yield* registry.lookup(run.record.name).pipe(Effect.flip)).toMatchObject({
        _tag: "SchemaError",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps new live caches consistent with the store's redacted diagnostic text", () =>
    Effect.gen(function* () {
      const { registry, run } = yield* fixture();
      yield* registry.question(run, { ...asked, question: "Choose token=PRIVATE_VALUE" });
      yield* registry.handoff(run, "Finished token=PRIVATE_VALUE\nDetails");
      yield* registry.event(run, { _tag: "Retrying", message: "Retry token=PRIVATE_VALUE" });
      const view = projectRun(run, "repo", 2000);
      const stored = yield* Store.readHandoff(run.dir, 1);
      expect(view.activity?.text).toBe(stored.handoff?.text.split("\n")[0]);
      expect(view.questions[0]?.text).toBe(
        Store.pendingQuestions(yield* Store.readQuestions(run.dir))[0]?.question,
      );
      expect(view.retrying?.message).toBe("Retry token=[redacted]");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "projects question and handoff writes, state ages and turn attention, including reload",
    () =>
      Effect.gen(function* () {
        const { registry, run, home } = yield* fixture();
        yield* registry.question(run, asked);
        yield* registry.handoff(run, "Finished.\nDetails");
        yield* registry.event(run, { _tag: "Retrying", message: "Retry later" });
        yield* registry.event(run, { _tag: "HookBlocked", event: "PreToolUse", feedback: "scope" });
        let view = projectRun(run, "repo", 2000);
        expect(view).toMatchObject({
          stateSince: at,
          title: "Test task",
          questions: [
            { id: q1, text: "Which path?", askedAt: at, defersAt: DateTime.makeUnsafe(2000) },
          ],
          unansweredCount: 0,
          hooksBlocked: 1,
          retrying: { message: "Retry later" },
          activity: { kind: "outcome", text: "Finished." },
        });
        yield* registry.question(run, { _tag: "Deferred", id: q1, by: "orchestrator", at });
        const reloaded = yield* makeRegistry(home);
        const loaded = yield* reloaded.lookup(run.record.name);
        expect(projectRun(loaded, "repo", 2000)).toMatchObject({
          questions: [],
          unansweredCount: 1,
          activity: { kind: "outcome", text: "Finished." },
        });
        yield* registry.question(run, {
          _tag: "Resolved",
          id: q1,
          resolution: "late",
          text: "A",
          at,
        });
        yield* TestClock.setTime(3000);
        yield* registry.state(run, "running");
        yield* registry.save(run, {
          tokens: { input: 100, cachedInput: 50, output: 20, reasoningOutput: 10 },
        });
        yield* registry.event(run, { _tag: "TurnStarted", turn: 2, kind: "followup" });
        view = projectRun(run, "repo", 3000);
        expect(view).toMatchObject({
          stateSince: DateTime.makeUnsafe(3000),
          tokensTotal: 120,
          questions: [],
          unansweredCount: 0,
          retrying: null,
          hooksBlocked: 0,
        });
        const result = yield* overview(registry, metadata, { _tag: "Overview" });
        const wire = Schema.encodeSync(Overview)(result);
        expect(wire.runs[0]?.stateSince).toBe("1970-01-01T00:00:03.000Z");
        expect(Schema.encodeSync(Overview)(Schema.decodeUnknownSync(Overview)(wire))).toEqual(wire);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "waits outside run locks, coalesces ten changes, and returns immediately for stale versions",
    () =>
      Effect.gen(function* () {
        const { registry, run } = yield* fixture();
        const initial = yield* overview(registry, metadata, { _tag: "Overview" });
        const pending = yield* overview(registry, metadata, {
          _tag: "Overview",
          after: initial.version,
          timeoutMs: 10000,
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust(100);
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* run.lock.withPermits(1)(registry.state(run, "running"));
        for (let i = 1; i <= 10; i++)
          yield* run.lock.withPermits(1)(
            registry.event(run, {
              _tag: "TokenUsage",
              totals: { input: i, cachedInput: 0, output: i, reasoningOutput: 0 },
            }),
          );
        yield* TestClock.adjust(249);
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(pending);
        expect(result.version).toBe(registry.version);
        expect(result.runs[0]?.state).toBe("running");
        expect(yield* Clock.currentTimeMillis).toBe(350);
        const immediate = yield* overview(registry, metadata, {
          _tag: "Overview",
          after: initial.version,
        });
        expect(immediate).toEqual(result);
        expect(yield* Clock.currentTimeMillis).toBe(350);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns unchanged versions at the timeout, defaulting to fifteen seconds", () =>
    Effect.gen(function* () {
      const { registry } = yield* fixture();
      for (const timeoutMs of [1000, undefined]) {
        const pending = yield* overview(registry, metadata, {
          _tag: "Overview",
          after: registry.version,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust((timeoutMs ?? 15000) - 1);
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        expect((yield* Fiber.join(pending)).version).toBe(registry.version);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("answers for twenty loaded runs without touching journals", () =>
    Effect.gen(function* () {
      const { registry, fs } = yield* fixture(20);
      // After load, missing journals cannot affect a cached projection.
      for (const run of registry.runs.values()) {
        yield* fs.writeFileString(`${run.dir}/events.jsonl`, "invalid\n");
        yield* fs.writeFileString(`${run.dir}/questions.jsonl`, "invalid\n");
        yield* fs.remove(`${run.dir}/contract.md`);
      }
      const result = yield* overview(registry, metadata, { _tag: "Overview" });
      expect(result.runs).toHaveLength(20);
      expect(result.runs.every((run) => run.title === "Test task")).toBe(true);
      const old = [...registry.runs.values()][0];
      assert.isDefined(old);
      // Restore the journals before exercising the normal archive interface.
      yield* fs.writeFileString(`${old.dir}/events.jsonl`, "");
      yield* fs.writeFileString(`${old.dir}/questions.jsonl`, "");
      yield* registry.archive(old.record.name);
      expect((yield* overview(registry, metadata, { _tag: "Overview" })).runs).toHaveLength(19);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "renders local attention hints, foreign ownership, budgets, quiet runs and child ages",
    () =>
      Effect.gen(function* () {
        const { run } = yield* fixture();
        const local = {
          ...projectRun(run, "repo", 600000),
          state: "running" as const,
          stateSince: DateTime.makeUnsafe(0),
          quiet: true,
          outsideMayChange: 2,
          lastActivityAt: at,
          questions: [
            {
              id: q1,
              kind: "blocked" as const,
              text: "Which path?",
              askedAt: at,
              defersAt: DateTime.makeUnsafe(900000),
            },
          ],
          subagents: [
            {
              threadId: "child",
              path: "/root/tests",
              model: null,
              effort: null,
              state: "working" as const,
              startedAt: at,
              lastInteractionAt: at,
              interactions: 1,
            },
          ],
        };
        const foreign = {
          ...local,
          name: Schema.decodeUnknownSync(D.RunName)("foreign"),
          group: "/foreign",
          repo: "foreign",
        };
        const text = renderOverview(
          { _tag: "Overview", version: 1, daemon: metadata, runs: [foreign, local] },
          "/repo",
          "FOREMAN_HOME=/home /bin/foreman",
          600000,
        );
        expect(text).toBe(
          [
            "2 runs: 2 running",
            "",
            "repo (/repo)",
            "run-0  running 10m00s  turn 1 (start)  model high priority read-only  budget 9m59s/1m00s  q1 (blocked) pending 9m59s, auto-defer in 5m00s: Which path?  2 outside scope  quiet 9m59s",
            "  /root/tests  working · 9m59s ago",
            '  next: FOREMAN_HOME=/home /bin/foreman answer run-0 q1 "<answer>"',
            "  next: FOREMAN_HOME=/home /bin/foreman events run-0",
            "",
            "foreign (/foreign) · other repo: its own session supervises it",
            "foreign  running 10m00s  turn 1 (start)  model high priority read-only  budget 9m59s/1m00s  q1 (blocked) pending 9m59s, auto-defer in 5m00s: Which path?  2 outside scope  quiet 9m59s",
            "  /root/tests  working · 9m59s ago",
          ].join("\n"),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
