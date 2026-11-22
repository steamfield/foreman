// Phase 4 of plans/agy-provider.md (RFC 0002 "Steering", "Interrupt" and "Resume"): steering a
// running agy turn, the budget hand-off and resuming a session after a daemon restart, through
// the real daemon and supervisor with the fake ACP agent standing in for `agy acp`.
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { activeStates, QuestionId, type RunState } from "../src/schemas/daemon";
import {
  editInHandoff,
  lateAnswerAfterTurn,
  prompt,
  message as said,
  steeredTurn,
} from "./fixtures/fake-acp-agent/scenarios";
import { agyFixture, agyPlatform as platform } from "./helpers/agy";

type Fixture = Effect.Success<ReturnType<typeof agyFixture>>;

const QUESTION = "Should I use option A or option B?";
const q1 = Schema.decodeUnknownSync(QuestionId)("q1");
/** The fake's usage per prompt reply, as foreman's token totals. */
const oneReply = { input: 1200, cachedInput: 200, output: 50, reasoningOutput: 10 };

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
 * at once when the run settles in another inactive state, so a broken run reports why.
 */
const reach = Effect.fnUntraced(function* (f: Fixture, state: RunState, turn?: number) {
  while (true) {
    const result = yield* f.request({ _tag: "Status", name: f.name, cwd: f.repo });
    const digest = result._tag === "Digests" ? result.digests[0] : undefined;
    if (digest?.state === state && (turn === undefined || digest.turn === turn)) return digest;
    if (digest !== undefined && digest.state !== state && !activeStates.has(digest.state))
      return yield* fail(
        f,
        `run ${digest.state} at turn ${digest.turn} while waiting for ${state}: ${JSON.stringify(digest.failure)}`,
      );
    yield* Effect.sleep(20);
  }
});

/** Waits until the run's events contain one matching `expected`, and returns them all. */
const untilEvent = Effect.fnUntraced(function* (f: Fixture, expected: unknown) {
  while (true) {
    const events = yield* f.events;
    if (events.some((event) => expect.objectContaining(expected).asymmetricMatch(event)))
      return events;
    yield* Effect.sleep(20);
  }
});

/** The params of every message foreman sent the fake with `method`, in order. */
const sent = (messages: readonly unknown[], method: string) =>
  messages.flatMap((message) =>
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    message.method === method &&
    "params" in message
      ? [message.params]
      : [],
  );

/** The methods of every message foreman sent the fake, in order. */
const methodsOf = (messages: readonly unknown[]) =>
  messages.flatMap((message) =>
    typeof message === "object" && message !== null && "method" in message
      ? [String(message.method)]
      : [],
  );

const ofTag = (events: readonly unknown[], tag: string) =>
  events.filter(
    (event) => typeof event === "object" && event !== null && "_tag" in event && event._tag === tag,
  );

it.live(
  "a steer merges into the running turn, which ends only on the steer's reply",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture({ rules: [] });
      const held = yield* f.gate("held");
      yield* f.useScenario(steeredTurn(held));
      yield* f.start(true);
      yield* untilEvent(f, { _tag: "Command", command: "ls" });
      expect(
        yield* f.request({ _tag: "Steer", name: f.name, message: "Also check the log." }),
      ).toMatchObject({ _tag: "Accepted" });
      // The fake replied end_turn to the first prompt before it ran `git log` for the steer.
      const midTurn = yield* untilEvent(f, { _tag: "Command", command: "git log --oneline" });
      expect(ofTag(midTurn, "TurnCompleted")).toEqual([]);
      expect(midTurn).toContainEqual({ _tag: "Steered", message: "Also check the log." });
      expect(yield* reach(f, "running", 1)).toMatchObject({ turn: 1 });
      yield* f.openGate(held);
      yield* reach(f, "idle", 1);
      const events = yield* f.events;
      expect(ofTag(events, "TurnCompleted")).toEqual([
        expect.objectContaining({ turn: 1, status: "completed" }),
      ]);
      expect(ofTag(events, "TokenUsage").at(-1)).toEqual({
        _tag: "TokenUsage",
        totals: {
          input: 2 * oneReply.input,
          cachedInput: 2 * oneReply.cachedInput,
          output: 2 * oneReply.output,
          reasoningOutput: 2 * oneReply.reasoningOutput,
        },
      });
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 1, text: "Applied the steer." },
      });
      const prompts = sent(yield* f.received, "session/prompt");
      expect(prompts).toEqual([
        { sessionId: expect.any(String), prompt: [{ type: "text", text: expect.any(String) }] },
        {
          // The steer goes to the same session: agy merges it into the running turn.
          sessionId: (prompts[0] as { readonly sessionId: string }).sessionId,
          prompt: [{ type: "text", text: expect.stringContaining("Also check the log.") }],
        },
      ]);
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a late answer that reaches a finished agy turn is delivered as a follow-up",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* agyFixture({ rules: [] });
      const marker = `${f.root}/replying`;
      yield* f.useScenario(lateAnswerAfterTurn(QUESTION, marker, 200));
      yield* f.start(true, { questionTimeoutMs: 300 });
      while (!(yield* fs.exists(marker))) yield* Effect.sleep(5);
      // The prompt has replied; the supervisor may still be applying the burst, so a steer
      // would reach an agy turn that already ended. Either way the answer waits for the turn.
      expect(
        yield* f.request({ _tag: "Answer", name: f.name, question: q1, text: "Use B." }),
      ).toMatchObject({ _tag: "Accepted", delivery: "followup" });
      yield* reach(f, "idle", 2);
      const events = yield* f.events;
      expect(ofTag(events, "Steered")).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ _tag: "QuestionResolved", id: "q1", resolution: "late" }),
      );
      expect(ofTag(events, "TurnCompleted")).toEqual([
        expect.objectContaining({ turn: 1, status: "completed" }),
        expect.objectContaining({ turn: 2, status: "completed" }),
      ]);
      const prompts = sent(yield* f.received, "session/prompt");
      expect(prompts).toHaveLength(2);
      expect(JSON.stringify(prompts[1])).toContain("Use B.");
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 2, text: "Applied the late answer." },
      });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "the budget cancels the turn and the hand-off turn approves shell but refuses an edit",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture(editInHandoff());
      yield* f.start(true, { budgetMs: 300 });
      // agy ends a turn when a permission is refused, so the hand-off turn records the failure.
      const digest = yield* reach(f, "failed", 2);
      expect(digest.failure?.message).toContain(
        "foreman refused File notes.txt (edit) in the budget hand-off turn",
      );
      expect(methodsOf(yield* f.received)).toContain("session/cancel");
      const events = yield* f.events;
      expect(events).toContainEqual({ _tag: "TurnStarted", turn: 2, kind: "handoff" });
      expect(ofTag(events, "TurnCompleted")).toEqual([
        expect.objectContaining({ turn: 1, status: "interrupted" }),
        expect.objectContaining({ turn: 2, status: "failed" }),
      ]);
      expect(ofTag(events, "Permission")).toEqual([
        {
          _tag: "Permission",
          kind: "execute",
          title: "git status --short",
          decision: "approved",
        },
        { _tag: "Permission", kind: "edit", title: "File notes.txt", decision: "rejected" },
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({ _tag: "Command", command: "git status --short", exitCode: 0 }),
      );
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 2, text: "Hand-off: listed a.txt; notes.txt not written." },
      });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a follow-up after a daemon restart resumes the session on the run's model",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture({ rules: [prompt([said("First turn done.")])] });
      yield* f.start(true);
      yield* reach(f, "idle", 1);
      const before = yield* f.received;
      const [opened] = sent(before, "session/new");
      const [firstPrompt] = sent(before, "session/prompt");
      const session = (firstPrompt as { readonly sessionId: string }).sessionId;
      yield* f.restart({ rules: [prompt([said("Resumed and finished.")])] });
      expect(
        yield* f.request({ _tag: "Followup", name: f.name, message: "Now add tests." }),
      ).toMatchObject({ _tag: "Accepted" });
      yield* reach(f, "idle", 2);
      const after = (yield* f.received).slice(before.length);
      expect(methodsOf(after)).toEqual([
        "initialize",
        "session/resume",
        "session/set_config_option",
        "session/set_mode",
        "session/prompt",
      ]);
      expect(sent(after, "session/resume")).toEqual([
        {
          sessionId: session,
          // The supervisor passes the real path (/private/tmp on macOS), as session/new gets.
          cwd: expect.stringMatching(/\/repo\/work\/unit$/),
          mcpServers: (opened as { readonly mcpServers: unknown }).mcpServers,
        },
      ]);
      expect(sent(after, "session/set_config_option")).toEqual([
        { sessionId: session, configId: "model", value: "gemini-4-neon-low" },
      ]);
      expect(sent(after, "session/set_mode")).toEqual([{ sessionId: session, modeId: "default" }]);
      expect(yield* f.events).toContainEqual({
        _tag: "Resumed",
        sandbox: "default",
        model: "gemini-4-neon",
      });
      expect(yield* f.request({ _tag: "Result", name: f.name })).toMatchObject({
        handoff: { turn: 2, text: "Resumed and finished." },
      });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "token totals keep counting from the recorded total after a daemon restart",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture({ rules: [prompt([said("First turn done.")])] });
      yield* f.start(true);
      const first = yield* reach(f, "idle", 1);
      expect(first.tokens).toEqual({
        input: 1200,
        cachedInput: 200,
        output: 50,
        reasoningOutput: 10,
      });
      yield* f.restart({ rules: [prompt([said("Resumed and finished.")])] });
      yield* f.request({ _tag: "Followup", name: f.name, message: "Now add tests." });
      const second = yield* reach(f, "idle", 2);
      expect(second.tokens).toEqual({
        input: 2400,
        cachedInput: 400,
        output: 100,
        reasoningOutput: 20,
      });
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a follow-up with --effort sets the thinking level on the session before its prompt",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture({
        rules: [prompt([said("First turn done.")], "end_turn", true)],
      });
      yield* f.start(true);
      yield* reach(f, "idle", 1);
      const before = (yield* f.received).length;
      yield* f.request({
        _tag: "Followup",
        name: f.name,
        message: "Think harder.",
        effort: "high",
      });
      const digest = yield* reach(f, "idle", 2);
      expect(digest.effort).toBe("high");
      const after = (yield* f.received).slice(before);
      expect(methodsOf(after)).toEqual([
        "session/set_config_option",
        "session/set_mode",
        "session/prompt",
      ]);
      expect(sent(after, "session/set_config_option")).toEqual([
        { sessionId: expect.any(String), configId: "model", value: "gemini-4-neon-high" },
      ]);
    }).pipe(Effect.provide(platform)),
  30_000,
);

it.live(
  "a follow-up effort the model doesn't offer is refused with the valid levels and not saved",
  () =>
    Effect.gen(function* () {
      const f = yield* agyFixture({
        rules: [prompt([said("First turn done.")], "end_turn", true)],
      });
      yield* f.start(true);
      yield* reach(f, "idle", 1);
      const before = (yield* f.received).length;
      const error = yield* f
        .request({ _tag: "Followup", name: f.name, message: "Go.", effort: "xhigh" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ModelUnresolved",
        detail:
          "--effort xhigh is not valid for gemini-4-neon (agy). Use one of: low, medium, high.",
      });
      const digest = yield* reach(f, "idle", 1);
      expect(digest.effort).toBe("low");
      expect(methodsOf((yield* f.received).slice(before))).not.toContain("session/prompt");
    }).pipe(Effect.provide(platform)),
  30_000,
);
