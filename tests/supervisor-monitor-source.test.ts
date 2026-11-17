import { assert, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { renderStatus } from "../src/core/runs/digest";
import { QuestionId } from "../src/schemas/daemon";
import {
  askOrchestrator,
  interruptedTurn,
  successfulTurn,
} from "./fixtures/fake-app-server/scenarios";
import { runCli } from "./helpers/cli";
import { eventsFixture, eventsPlatform as platform } from "./helpers/events";

const question = Schema.decodeUnknownSync(QuestionId)("q1");
const fixture = Effect.fnUntraced(function* (hold = false) {
  const script = askOrchestrator();
  const f = yield* eventsFixture({
    rules: [
      ...script.rules.map((rule) =>
        hold && rule.method === "turn/start"
          ? { ...rule, steps: rule.steps?.slice(0, -1) }
          : { ...rule, ...(rule.method === "turn/steer" ? { repeat: true } : {}) },
      ),
      ...successfulTurn().rules.filter((rule) => rule.method === "turn/start"),
    ],
  });
  yield* f.untilState("waiting");
  const resolutions = Effect.gen(function* () {
    const reply = yield* f.request({ _tag: "Events", name: f.name });
    assert(reply._tag === "Events");
    return reply.events
      .map(({ event }) => event)
      .filter((event) => event._tag === "QuestionResolved");
  });
  return { ...f, resolutions };
});

const queuedFixture = Effect.fnUntraced(function* () {
  const work = askOrchestrator().rules.find((rule) => rule.method === "turn/start");
  const done = successfulTurn().rules.find((rule) => rule.method === "turn/start");
  const interrupted = interruptedTurn().rules.find((rule) => rule.method === "turn/start");
  assert(work !== undefined && done !== undefined && interrupted !== undefined);
  const f = yield* eventsFixture({
    rules: [
      ...askOrchestrator().rules.filter((rule) => rule.method !== "turn/start"),
      { ...work, steps: work.steps?.slice(0, -1) },
      { ...done, steps: [{ awaitRequest: "turn/steer" }, ...(done.steps?.slice(-1) ?? [])] },
      done,
      { method: "turn/interrupt", respond: { result: {} }, steps: interrupted.steps?.slice(-1) },
    ],
  });
  yield* f.untilState("waiting");
  yield* f.request({ _tag: "Defer", name: f.name, question });
  yield* f.untilState("running");
  yield* TestClock.adjust(3_600_000);
  while (true) {
    const status = yield* f.request({ _tag: "Status", name: f.name, cwd: `${f.root}/repo` });
    if (status._tag === "Digests" && status.digests[0]?.turnKind === "handoff") break;
    yield* Effect.yieldNow;
  }
  return f;
});

it.effect("a queued monitor answer retains its source at acceptance and follow-up delivery", () =>
  Effect.gen(function* () {
    const f = yield* queuedFixture();
    expect(
      yield* f.request({ _tag: "Answer", name: f.name, question, text: "A", source: "monitor" }),
    ).toMatchObject({ _tag: "Accepted", delivery: "queued" });
    yield* f.request({ _tag: "Steer", name: f.name, message: "Finish hand-off" });
    while (true) {
      const reply = yield* f.request({ _tag: "Events", name: f.name });
      assert(reply._tag === "Events");
      const late = reply.events
        .map(({ event }) => event)
        .filter((event) => event._tag === "QuestionResolved" && event.resolution === "late");
      if (late.length === 2) {
        expect(late).toEqual([
          { _tag: "QuestionResolved", id: question, resolution: "late", source: "monitor" },
          {
            _tag: "QuestionResolved",
            id: question,
            resolution: "late",
            source: "monitor",
            continuation: { id: expect.any(String), turn: 3 },
          },
        ]);
        break;
      }
      yield* Effect.yieldNow;
    }
    yield* f.untilState("idle");
  }).pipe(Effect.provide(platform)),
);

it.live.each([undefined, "monitor"] as const)(
  "open answer records source %s only when supplied",
  (source) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.request({
        _tag: "Answer",
        name: f.name,
        question,
        text: "A",
        ...(source ? { source } : {}),
      });
      yield* f.untilState("idle");
      expect(yield* f.resolutions).toStrictEqual([
        {
          _tag: "QuestionResolved",
          id: question,
          resolution: "answered",
          ...(source ? { source } : {}),
        },
      ]);
    }).pipe(Effect.provide(platform)),
);

it.live.each([undefined, "monitor"] as const)(
  "defer records source %s only when supplied",
  (source) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.request({ _tag: "Defer", name: f.name, question, ...(source ? { source } : {}) });
      yield* f.untilState("idle");
      expect(yield* f.resolutions).toStrictEqual([
        {
          _tag: "QuestionResolved",
          id: question,
          resolution: "deferred",
          ...(source ? { source } : {}),
        },
      ]);
    }).pipe(Effect.provide(platform)),
);

it.live("a deferred answer retains monitor attribution through a follow-up", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.request({ _tag: "Defer", name: f.name, question });
    yield* f.untilState("idle");
    expect(
      yield* f.request({
        _tag: "Answer",
        name: f.name,
        question,
        text: "A",
        source: "monitor",
        expectOpen: true,
      }),
    ).toMatchObject({ _tag: "Accepted", delivery: "followup" });
    yield* f.untilState("idle");
    expect((yield* f.resolutions).at(-1)).toEqual({
      _tag: "QuestionResolved",
      id: question,
      resolution: "late",
      source: "monitor",
    });
  }).pipe(Effect.provide(platform)),
);

it.live("late answers and corrections delivered by steer retain monitor attribution", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    yield* f.request({ _tag: "Defer", name: f.name, question });
    yield* f.untilState("running");
    for (const resolution of ["late", "correction"] as const) {
      expect(
        yield* f.request({ _tag: "Answer", name: f.name, question, text: "A", source: "monitor" }),
      ).toMatchObject({ _tag: "Accepted", delivery: "steer" });
      expect((yield* f.resolutions).at(-1)).toEqual({
        _tag: "QuestionResolved",
        id: question,
        resolution,
        source: "monitor",
      });
    }
  }).pipe(Effect.provide(platform)),
);

it.live.each([undefined, "monitor"] as const)(
  "interrupt source %s reaches events, status and wait",
  (source) =>
    Effect.gen(function* () {
      const f = yield* eventsFixture(interruptedTurn());
      yield* f.untilState("waiting");
      yield* f.request({ _tag: "Interrupt", name: f.name, ...(source ? { source } : {}) });
      yield* f.untilState("interrupted");
      const events = yield* f.request({ _tag: "Events", name: f.name });
      assert(events._tag === "Events");
      expect(
        events.events.filter(({ event }) => event._tag === "Interrupted").map(({ event }) => event),
      ).toEqual([{ _tag: "Interrupted", by: source ?? "orchestrator" }]);
      for (const args of [
        ["status", "unit"],
        ["wait", "unit", "--timeout", "0ms"],
      ]) {
        const result = yield* Effect.promise(() => runCli(args, { env: f.env }));
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(source ? "from foreman monitor" : "by the orchestrator");
      }
      const status = yield* f.request({ _tag: "Status", name: f.name, cwd: `${f.root}/repo` });
      assert(status._tag === "Digests" && status.digests[0] !== undefined);
      if (source) expect(renderStatus(status.digests[0])).toContain("from foreman monitor");
    }).pipe(Effect.provide(platform)),
);
