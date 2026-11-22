// Phase 3 of plans/agy-provider.md (RFC 0002 "Questions on agy"): agy runs ask through the real
// `foreman mcp-question` bridge, which the fake ACP agent launches from session/new's
// mcpServers, and the daemon's Ask request. Real daemon and supervisor throughout.
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../src/core/process";
import { activeStates, QuestionId, type RunState } from "../src/schemas/daemon";
import { deferral } from "../src/supervisor/prompts";
import {
  abandonedQuestionTurn,
  askAfterTurn,
  askInHandoff,
  questionTurn,
} from "./fixtures/fake-acp-agent/scenarios";
import { agyFixture, agyPlatform as platform } from "./helpers/agy";

type Fixture = Effect.Success<ReturnType<typeof agyFixture>>;

const QUESTION = "Should I use option A or option B?";
const q1 = Schema.decodeUnknownSync(QuestionId)("q1");

/** Dies with `problem` and the tail of agy's stderr, where the fake and the bridge report. */
const fail = Effect.fnUntraced(function* (f: Fixture, problem: string) {
  const fs = yield* FileSystem.FileSystem;
  const stderr = yield* fs
    .readFileString(`${f.home}/logs/agy-stderr.log`)
    .pipe(Effect.orElseSucceed(() => ""));
  return yield* Effect.die(new Error(`${problem}\nagy stderr:\n${stderr.slice(-1500)}`));
});

/**
 * Waits until run `unit` reaches `state` (and `turn`, when given), returning its digest. Fails
 * at once when the run settles in another inactive state, so a broken run reports why instead
 * of timing out.
 */
const reach = Effect.fnUntraced(function* (f: Fixture, state: RunState, turn?: number) {
  while (true) {
    const result = yield* f.request({ _tag: "Status", name: f.name, cwd: f.repo });
    const digest = result._tag === "Digests" ? result.digests[0] : undefined;
    if (digest?.state === state && (turn === undefined || digest.turn === turn)) return digest;
    if (digest !== undefined && digest.state !== state && !activeStates.has(digest.state))
      return yield* fail(
        f,
        `run ${digest.state} while waiting for ${state}: ${JSON.stringify(digest.failure)}`,
      );
    yield* Effect.sleep(20);
  }
});

/** Waits up to 10 s until the fake logged `count` ended MCP calls, and returns them. */
const untilMcpResults = Effect.fnUntraced(function* (f: Fixture, count: number) {
  for (let waited = 0; waited < 10_000; waited += 20) {
    const results = yield* f.mcpResults;
    if (results.length >= count) return results;
    yield* Effect.sleep(20);
  }
  return yield* fail(f, `the fake logged fewer than ${count} MCP results`);
});

/** Waits until the run's events satisfy `found`, and returns them. */
const untilEvents = Effect.fnUntraced(function* (
  f: Fixture,
  found: (events: readonly unknown[]) => boolean,
) {
  while (true) {
    const events = yield* f.events;
    if (found(events)) return events;
    yield* Effect.sleep(20);
  }
});

const resolved = (id: string, resolution: string) => (events: readonly unknown[]) =>
  events.some((event) =>
    expect.objectContaining({ _tag: "QuestionResolved", id, resolution }).asymmetricMatch(event),
  );

/** The tools/call response the bridge returns for a text result. */
const toolText = (text: string, isError = false) => ({
  label: "q",
  response: {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
  },
});

/** A gate whose release is a FIFO, so the fake blocks until the test opens it. */
const makeGate = Effect.fnUntraced(function* (directory: string, label: string) {
  const gate = { ready: `${directory}/${label}-ready`, release: `${directory}/${label}-release` };
  const made = yield* commandResult(ChildProcess.make("mkfifo", [gate.release]));
  if (made.code !== 0) return yield* Effect.die(`mkfifo failed: ${made.stderr}`);
  return gate;
});

/** Opens a gate: the write completes once the blocked fake has read it. */
const openGate = Effect.fnUntraced(function* (gate: { readonly release: string }) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(gate.release, "go");
});

it.live(
  "a question waits for foreman answer and the tool result carries the answer",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(questionTurn(QUESTION));
      yield* f.start(true);
      const waiting = yield* reach(f, "waiting");
      expect(waiting.questions).toEqual([
        { id: "q1", kind: "question", question: QUESTION, pendingMs: expect.any(Number) },
      ]);
      expect(
        yield* f.request({ _tag: "Answer", name: f.name, question: q1, text: "Use B." }),
      ).toMatchObject({ _tag: "Accepted", delivery: "response" });
      yield* reach(f, "idle");
      expect(yield* untilMcpResults(f, 1)).toEqual([toolText("Use B.")]);
      expect(yield* f.events).toContainEqual(
        expect.objectContaining({ _tag: "QuestionResolved", id: "q1", resolution: "answered" }),
      );
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 1, text: "Done after the answer." },
      });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "foreman defer answers the held call with the deferral text",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(questionTurn(QUESTION));
      yield* f.start(true);
      yield* reach(f, "waiting");
      expect(yield* f.request({ _tag: "Defer", name: f.name, question: q1 })).toMatchObject({
        _tag: "Accepted",
      });
      yield* reach(f, "idle");
      expect(yield* untilMcpResults(f, 1)).toEqual([toolText(deferral)]);
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "the question timeout defers the held call",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(questionTurn(QUESTION));
      yield* f.start(true, { questionTimeoutMs: 300 });
      yield* reach(f, "idle");
      expect(yield* untilMcpResults(f, 1)).toEqual([toolText(deferral)]);
      expect(yield* f.events).toContainEqual(
        expect.objectContaining({ _tag: "QuestionResolved", id: "q1", resolution: "deferred" }),
      );
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "killing the bridge mid-question cancels it, resumes the run and makes the answer late",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const gates = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-gate-" });
      const held = yield* makeGate(gates, "held");
      const resume = yield* makeGate(gates, "resume");
      const f = yield* agyFixture(abandonedQuestionTurn(QUESTION, held, resume));
      yield* f.start(true);
      yield* reach(f, "waiting");
      yield* openGate(held);
      yield* untilEvents(f, resolved("q1", "cancelled"));
      const running = yield* reach(f, "running");
      expect(running.questions).toEqual([]);
      expect(yield* f.mcpResults).toEqual([
        { label: "q", exited: { code: null, signal: "SIGKILL" } },
      ]);
      // A late answer waits for the turn (or steers it); it never goes to the dead call.
      const answer = yield* f
        .request({ _tag: "Answer", name: f.name, question: q1, text: "Use B." })
        .pipe(Effect.forkScoped);
      yield* openGate(resume);
      expect(yield* Fiber.join(answer)).toMatchObject({
        _tag: "Accepted",
        delivery: expect.stringMatching(/^(steer|followup)$/),
      });
      yield* untilEvents(f, resolved("q1", "late"));
      yield* reach(f, "idle");
      const prompts = (yield* f.received).filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "session/prompt",
      );
      expect(JSON.stringify(prompts.at(-1))).toContain("Use B.");
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "an ask with no prompt outstanding is refused as no longer active",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(askAfterTurn(QUESTION));
      yield* f.start(true);
      yield* reach(f, "idle");
      expect(yield* untilMcpResults(f, 1)).toEqual([
        { ...toolText("turn is no longer active", true), label: "late" },
      ]);
      expect(yield* f.events).not.toContainEqual(
        expect.objectContaining({ _tag: "QuestionAsked" }),
      );
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "the budget hand-off turn refuses agy's permission to ask",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(askInHandoff(QUESTION));
      yield* f.start(true, { budgetMs: 300 });
      const digest = yield* reach(f, "failed", 2);
      expect(digest.failure?.message).toContain(
        "foreman refused Run mcp_foreman_ask_orchestrator (other) in the budget hand-off turn",
      );
      const events = yield* f.events;
      expect(events).toContainEqual({ _tag: "TurnStarted", turn: 2, kind: "handoff" });
      expect(events).toContainEqual({
        _tag: "Permission",
        kind: "other",
        title: "Run mcp_foreman_ask_orchestrator",
        decision: "rejected",
      });
      expect(events).not.toContainEqual(expect.objectContaining({ _tag: "QuestionAsked" }));
      expect(yield* f.mcpResults).toEqual([]);
    }).pipe(Effect.provide(platform)),
  30_000,
);
