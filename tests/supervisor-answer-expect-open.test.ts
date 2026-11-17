import { assert, expect, it } from "@effect/vitest";
import { DateTime, Effect, Fiber, FileSystem, Schema } from "effect";
import { openActing } from "../src/core/monitor/acting";
import * as Store from "../src/core/runs/store";
import { QuestionId, RunName } from "../src/schemas/daemon";
import type { Scenario } from "./fixtures/fake-app-server/scenario";
import { askOrchestrator, successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { eventsFixture, eventsPlatform as platform } from "./helpers/events";

const name = Schema.decodeUnknownSync(RunName)("unit");
const question = Schema.decodeUnknownSync(QuestionId)("q1");

const fixture = Effect.fnUntraced(function* (script: Scenario = askOrchestrator()) {
  const f = yield* eventsFixture({
    rules: [
      ...script.rules,
      ...successfulTurn()
        .rules.filter((rule) => rule.method === "turn/start")
        .map((rule) => ({ ...rule, repeat: true })),
    ],
  });
  yield* f.untilState("waiting");
  const fs = yield* FileSystem.FileSystem;
  const dir = `${f.env.FOREMAN_HOME}/runs/unit`;
  const answer = (expectOpen?: true) =>
    f.request({
      _tag: "Answer",
      name,
      question,
      text: "Use A",
      ...(expectOpen ? { expectOpen } : {}),
    });
  const snapshot = Effect.all({
    questions: Store.readQuestions(dir),
    events: Store.readEvents(dir, 0),
    record: Store.readRun(dir),
    wire: fs.readFileString(`${f.root}/received.jsonl`),
  });
  return {
    request: f.request,
    until: f.untilState,
    dir,
    answer,
    snapshot,
    home: f.env.FOREMAN_HOME,
  };
});

it.live("expectOpen answers a pending question through its held RPC", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(yield* f.answer(true)).toMatchObject({ _tag: "Accepted", delivery: "response" });
    yield* f.until("idle");
    const snapshot = yield* f.snapshot;
    expect(snapshot.questions.at(-1)).toMatchObject({
      resolution: "answered",
      delivery: "response",
      text: "Use A",
    });
    expect(snapshot.wire).toContain('"contentItems":[{"type":"inputText","text":"Use A"}]');
  }).pipe(Effect.provide(platform)),
);

it.live.each([
  "answered",
  "auto-answered",
  "late",
  "correction",
  "cancelled",
  "superseded",
] as const)("expectOpen refuses %s without events, wire traffic or another turn", (resolution) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.answer();
    yield* f.until("idle");
    // Historical resolutions include states without a current producer, such as auto-answered.
    yield* Store.appendQuestion(f.dir, {
      _tag: "Resolved",
      id: question,
      resolution,
      text: "earlier",
      at: DateTime.makeUnsafe(1),
    });
    const before = yield* f.snapshot;
    const error = yield* f.answer(true).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "RunConflict",
      detail: `Question q1 in run unit was resolved as ${resolution}; nothing was sent. Use foreman answer unit q1 "<text>" to send a late answer or correction.`,
    });
    expect(yield* f.snapshot).toEqual(before);
  }).pipe(Effect.provide(platform)),
);

it.live("expectOpen accepts a deferred question as a late follow-up answer", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.request({ _tag: "Defer", name, question });
    yield* f.until("idle");
    expect(yield* f.answer(true)).toMatchObject({ _tag: "Accepted", delivery: "followup" });
    yield* f.until("idle");
    expect((yield* f.snapshot).questions.at(-1)).toMatchObject({
      resolution: "late",
      delivery: "followup",
      text: "Use A",
    });
  }).pipe(Effect.provide(platform)),
);

it.live("an answer without expectOpen still sends a correction after resolution", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.answer();
    yield* f.until("idle");
    expect(yield* f.answer()).toMatchObject({ _tag: "Accepted", delivery: "followup" });
    yield* f.until("idle");
    expect((yield* f.snapshot).questions.at(-1)).toMatchObject({
      resolution: "correction",
      delivery: "followup",
    });
  }).pipe(Effect.provide(platform)),
);

it.live("concurrent expectOpen answers have exactly one winner", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const results = yield* Effect.all(
      [f.answer(true).pipe(Effect.result), f.answer(true).pipe(Effect.result)],
      { concurrency: "unbounded" },
    );
    expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
    const failed = results.find((result) => result._tag === "Failure");
    assert(failed?._tag === "Failure");
    expect(failed.failure._tag).toBe("RunConflict");
    yield* f.until("idle");
    expect((yield* f.snapshot).questions.filter((line) => line._tag === "Resolved")).toHaveLength(
      1,
    );
  }).pipe(Effect.provide(platform)),
);

it.live.each(["answer", "defer"] as const)("acting sends %s and returns its outcome line", (kind) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const session = yield* openActing(f.home);
    expect(yield* session.send({ kind, name, question, text: "café 🐈" })).toBe(
      kind === "answer" ? "answered unit q1 · 10 bytes" : "deferred unit q1",
    );
    yield* f.until("idle");
    expect((yield* f.snapshot).questions.at(-1)).toMatchObject(
      kind === "answer"
        ? { resolution: "answered", text: "café 🐈" }
        : { _tag: "Deferred", id: question },
    );
  }).pipe(Effect.provide(platform)),
);

it.live("acting refuses an answer already sent by the CLI", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const session = yield* openActing(f.home);
    yield* f.answer();
    yield* f.until("idle");
    const before = yield* f.snapshot;
    expect(
      (yield* session.send({ kind: "answer", name, question, text: "second" }).pipe(Effect.flip))
        ._tag,
    ).toBe("RunConflict");
    expect(yield* f.snapshot).toEqual(before);
    expect(
      (yield* session
        .send({ kind: "defer", name: Schema.decodeUnknownSync(RunName)("missing"), question })
        .pipe(Effect.flip))._tag,
    ).toBe("RunNotFound");
  }).pipe(Effect.provide(platform)),
);

it.live("concurrent deferred answers recheck resolution before starting a follow-up", () =>
  Effect.gen(function* () {
    const script = askOrchestrator();
    const f = yield* fixture({
      rules: [
        ...script.rules.map((rule) => {
          if (rule.method === "turn/start")
            return {
              ...rule,
              steps: [
                ...(rule.steps?.slice(0, -1) ?? []),
                { awaitRequest: "turn/interrupt" },
                ...(rule.steps?.slice(-1) ?? []),
              ],
            };
          if (rule.method === "turn/steer")
            return {
              ...rule,
              repeat: true,
              respond: { error: { code: -32602, message: "activeTurnNotSteerable" } },
            };
          return rule;
        }),
        { method: "turn/interrupt", respond: { result: {} } },
      ],
    });
    yield* f.request({ _tag: "Defer", name, question });
    yield* f.until("running");
    const first = yield* f.answer(true).pipe(Effect.result, Effect.forkChild);
    const second = yield* f.answer(true).pipe(Effect.result, Effect.forkChild);
    // Both answers have inspected the deferred question and attempted the refused steer.
    while ((yield* f.snapshot).wire.split('"method":"turn/steer"').length < 3)
      yield* Effect.yieldNow;
    yield* f.request({ _tag: "Interrupt", name });
    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
    expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
    const loser = results.find((result) => result._tag === "Failure");
    assert(loser?._tag === "Failure");
    expect(loser.failure._tag).toBe("RunConflict");
    yield* f.until("idle");
    expect((yield* f.snapshot).questions.filter((line) => line._tag === "Resolved")).toHaveLength(
      1,
    );
  }).pipe(Effect.provide(platform)),
);
