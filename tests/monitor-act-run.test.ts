import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { expect } from "vitest";
import type { ActMessage, ActState } from "../src/core/monitor/act";
import type { ActingSession } from "../src/core/monitor/acting";
import { DaemonUnavailable, errorTable, RunConflict } from "../src/errors";
import { QuestionId, RunName } from "../src/schemas/daemon";
import { runActing } from "../src/tui/run";
import { eventsPlatform } from "./helpers/events";

type Request = NonNullable<ActState["inFlight"]>;
const name = Schema.decodeUnknownSync(RunName)("fix-hooks");
const question = Schema.decodeUnknownSync(QuestionId)("q2");
const fixture = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<Request>();
  const messages = yield* Queue.unbounded<ActMessage>();
  const closed = yield* Deferred.make<void>();
  const finalized = yield* Deferred.make<void>();
  const sends: unknown[] = [];
  const received: ActMessage[] = [];
  let opens = 0;
  const session: ActingSession = {
    closed: Deferred.await(closed),
    send: (intent) =>
      Effect.sync(() => {
        sends.push(intent);
        return `${intent.kind} fixture result`;
      }),
  };
  const opener = () =>
    Effect.gen(function* () {
      opens++;
      yield* Effect.addFinalizer(() => Deferred.succeed(finalized, undefined));
      return session;
    });
  const dispatch = (message: ActMessage) => {
    received.push(message);
    Queue.offerUnsafe(messages, message);
  };
  return {
    requests,
    messages,
    closed,
    finalized,
    sends,
    received,
    opener,
    dispatch,
    opens: () => opens,
  };
});

it.effect("opens each new enter intent once and reports acting", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const worker = yield* Effect.forkChild(
      runActing(f.opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    expect(yield* Queue.take(f.messages)).toEqual({
      type: "act-outcome",
      outcome: { id: 1, ok: true, text: "acting" },
    });
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    yield* Queue.offer(f.requests, { id: 2, intent: { kind: "leave-acting" } });
    expect(yield* Queue.take(f.messages)).toEqual({
      type: "act-outcome",
      outcome: { id: 2, ok: true, text: "watching" },
    });
    expect(f.opens()).toBe(1);
    yield* Fiber.interrupt(worker);
  }).pipe(Effect.provide(eventsPlatform)),
);

it.effect("leaving closes the session scope without reporting connection loss", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const worker = yield* Effect.forkChild(
      runActing(f.opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    yield* Queue.take(f.messages);
    yield* Queue.offer(f.requests, { id: 2, intent: { kind: "leave-acting" } });
    yield* Queue.take(f.messages);
    expect(yield* Deferred.isDone(f.finalized)).toBe(true);
    yield* Deferred.succeed(f.closed, undefined);
    yield* Fiber.interrupt(worker);
    expect(f.received.map((message) => message.type)).toEqual(["act-outcome", "act-outcome"]);
  }).pipe(Effect.provide(eventsPlatform)),
);

it.effect("answer and defer send the exact intent and report the session's text", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const worker = yield* Effect.forkChild(
      runActing(f.opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    yield* Queue.take(f.messages);
    const intents = [
      { kind: "answer", name, question, text: " Keep the API.\n" },
      { kind: "defer", name, question },
    ] as const;
    for (const [index, intent] of intents.entries()) {
      yield* Queue.offer(f.requests, { id: index + 2, intent });
      expect(yield* Queue.take(f.messages)).toEqual({
        type: "act-outcome",
        outcome: { id: index + 2, ok: true, text: `${intent.kind} fixture result` },
      });
    }
    expect(f.sends).toEqual(intents);
    yield* Fiber.interrupt(worker);
  }).pipe(Effect.provide(eventsPlatform)),
);

it.effect("failed sends preserve the error detail and the session stays usable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const opener = () =>
      f.opener().pipe(
        Effect.map((session) => ({
          ...session,
          send: () => Effect.fail(new RunConflict({ detail: "q2 was already answered" })),
        })),
      );
    const worker = yield* Effect.forkChild(
      runActing(opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    yield* Queue.take(f.messages);
    yield* Queue.offer(f.requests, {
      id: 2,
      intent: { kind: "answer", name, question, text: "keep" },
    });
    expect(yield* Queue.take(f.messages)).toEqual({
      type: "act-outcome",
      outcome: { id: 2, ok: false, text: "q2 was already answered" },
    });
    expect(yield* Deferred.isDone(f.finalized)).toBe(false);
    yield* Fiber.interrupt(worker);
  }).pipe(Effect.provide(eventsPlatform)),
);

it.effect("a failed opener reports its detail, or the safe table message when absent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const failures = [
      new DaemonUnavailable({ detail: "Run foreman status fix-hooks first." }),
      new DaemonUnavailable(),
    ];
    let index = 0;
    const opener = () => Effect.fail(failures[index++] ?? new DaemonUnavailable());
    const worker = yield* Effect.forkChild(
      runActing(opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    for (const [index, error] of failures.entries()) {
      yield* Queue.offer(f.requests, {
        id: index + 1,
        intent: { kind: "enter-acting", resume: "answer" },
      });
      expect(yield* Queue.take(f.messages)).toEqual({
        type: "act-outcome",
        outcome: {
          id: index + 1,
          ok: false,
          text: error.detail ?? errorTable.DaemonUnavailable.message,
        },
      });
    }
    yield* Fiber.interrupt(worker);
  }).pipe(Effect.provide(eventsPlatform)),
);

it.effect("an unsolicited socket close reports acting-lost once and releases the scope", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const worker = yield* Effect.forkChild(
      runActing(f.opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    yield* Queue.take(f.messages);
    yield* Deferred.succeed(f.closed, undefined);
    expect(yield* Queue.take(f.messages)).toEqual({
      type: "acting-lost",
      text: "The daemon connection closed; back to watching.",
    });
    yield* Deferred.await(f.finalized);
    yield* Fiber.interrupt(worker);
    expect(f.received.filter((message) => message.type === "acting-lost")).toHaveLength(1);
  }).pipe(Effect.provide(eventsPlatform)),
);

it.effect("quitting the executor releases an open session", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const worker = yield* Effect.forkChild(
      runActing(f.opener, Stream.fromQueue(f.requests), f.dispatch),
    );
    yield* Queue.offer(f.requests, { id: 1, intent: { kind: "enter-acting", resume: "answer" } });
    yield* Queue.take(f.messages);
    yield* Fiber.interrupt(worker);
    expect(yield* Deferred.isDone(f.finalized)).toBe(true);
    expect(f.received).toEqual([
      { type: "act-outcome", outcome: { id: 1, ok: true, text: "acting" } },
    ]);
  }).pipe(Effect.provide(eventsPlatform)),
);
