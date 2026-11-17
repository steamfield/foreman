import { it } from "@effect/vitest";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { createElement } from "react";
import { expect } from "vitest";
import type { DetailFeed } from "../src/core/monitor/detail-feed";
import type { MonitorFeed } from "../src/core/monitor/feed";
import type { Message } from "../src/core/monitor/model";
import { RunName } from "../src/schemas/daemon";
import { Terminal } from "../src/services/terminal";
import { runMonitor, runPreview } from "../src/tui/run";
import { MonitorApp } from "../src/tui/screen";
import { eventsPlatform } from "./helpers/events";
import { defaults, live, now, run } from "./helpers/monitor";
import { monitorTerminal } from "./helpers/monitor-terminal";

const observer: { current: Parameters<typeof MonitorApp>[0] | undefined } = { current: undefined };
const ObservingApp: typeof MonitorApp = (props) => {
  observer.current = props;
  return createElement(MonitorApp, props);
};

const names = ["first", "second", "third"].map((name) => Schema.decodeUnknownSync(RunName)(name));
const first = Schema.decodeUnknownSync(RunName)("first");
const third = Schema.decodeUnknownSync(RunName)("third");
const fixture = Effect.gen(function* () {
  const selected = yield* Queue.unbounded<RunName | null>();
  const messages = yield* Queue.unbounded<Message>();
  const consumed = yield* Queue.unbounded<RunName | null>();
  const opened: RunName[] = [];
  const closed: RunName[] = [];
  const detail = (name: RunName) =>
    Stream.fromEffect(
      Effect.acquireRelease(
        Effect.sync(() => {
          opened.push(name);
          return { _tag: "Archived" as const, receivedAt: now };
        }),
        () =>
          Effect.sync(() => {
            closed.push(name);
          }),
      ),
    ).pipe(Stream.concat(Stream.never), Stream.scoped);
  const worker = yield* Effect.forkChild(
    runPreview(
      Stream.fromQueue(selected).pipe(Stream.tap((name) => Queue.offer(consumed, name))),
      detail,
      (message) => {
        Queue.offerUnsafe(messages, message);
      },
    ),
  );
  return { selected, consumed, messages, opened, closed, worker };
});

it.effect("subscribes once after 250ms of stable selection and carries the selected name", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Queue.offer(f.selected, first);
    yield* Queue.take(f.consumed);
    yield* TestClock.adjust(0);
    yield* TestClock.adjust(249);
    expect(f.opened).toEqual([]);
    yield* TestClock.adjust(1);
    expect(yield* Queue.take(f.messages)).toEqual({
      type: "preview-feed",
      name: first,
      value: { _tag: "Archived", receivedAt: now },
    });
    yield* Queue.offer(f.selected, first);
    yield* Queue.take(f.consumed);
    yield* TestClock.adjust(0);
    yield* TestClock.adjust(1000);
    expect(f.opened).toEqual([first]);
    yield* Fiber.interrupt(f.worker);
    expect(f.closed).toEqual([first]);
  }),
);
it.effect("quick scrolling across three runs opens only the final stream", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const name of names) {
      yield* Queue.offer(f.selected, name);
      yield* Queue.take(f.consumed);
      yield* TestClock.adjust(100);
    }
    expect(f.opened).toEqual([]);
    yield* TestClock.adjust(150);
    expect(yield* Queue.take(f.messages)).toMatchObject({ type: "preview-feed", name: third });
    expect(f.opened).toEqual([third]);
    yield* Fiber.interrupt(f.worker);
  }),
);
it.effect(
  "clearing selection stops an open stream and cancels a pending subscription immediately",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Queue.offer(f.selected, first);
      yield* Queue.take(f.consumed);
      yield* TestClock.adjust(0);
      yield* TestClock.adjust(250);
      yield* Queue.take(f.messages);
      yield* Queue.offer(f.selected, third);
      yield* Queue.take(f.consumed);
      yield* TestClock.adjust(0);
      expect(f.closed).toEqual([first]);
      yield* Queue.offer(f.selected, null);
      yield* Queue.take(f.consumed);
      yield* TestClock.adjust(250);
      expect(f.opened).toEqual([first]);
      yield* Fiber.interrupt(f.worker);
    }),
);
it.effect(
  "the monitor switches preview selection, stops it on detail open, and clears it with the list",
  () =>
    Effect.gen(function* () {
      const terminal = monitorTerminal(140);
      const feed = yield* Queue.unbounded<MonitorFeed>();
      const opened = yield* Queue.unbounded<RunName>();
      const closed = yield* Queue.unbounded<RunName>();
      observer.current = undefined;
      const detail = (name: RunName): Stream.Stream<DetailFeed> =>
        Stream.fromEffect(
          Effect.acquireRelease(
            Queue.offer(opened, name).pipe(
              Effect.as({ _tag: "Archived" as const, receivedAt: now }),
            ),
            () => Queue.offer(closed, name),
          ),
        ).pipe(Stream.concat(Stream.never), Stream.scoped);
      const worker = yield* Effect.forkChild(
        runMonitor(
          yield* Terminal.pipe(Effect.provide(terminal.layer)),
          { group: "/repo", defaults, version: "test", now, columns: 140, rows: 40 },
          Stream.fromQueue(feed),
          detail,
          true,
          undefined,
          ObservingApp,
        ).pipe(Effect.scoped),
      );
      yield* Queue.offer(feed, live(names.map((name) => run(name))));
      yield* Effect.promise(() => terminal.waitFor("first"));
      yield* TestClock.adjust(250);
      expect(yield* Queue.take(opened)).toBe(first);
      yield* Effect.sync(() => observer.current?.onKey("end"));
      yield* TestClock.adjust(250);
      expect(yield* Queue.take(closed)).toBe(first);
      expect(yield* Queue.take(opened)).toBe(third);
      yield* Effect.sync(() => observer.current?.onKey("enter"));
      expect(yield* Queue.take(closed)).toBe(third);
      expect(yield* Queue.take(opened)).toBe(third);
      yield* Effect.sync(() => observer.current?.onKey("escape"));
      yield* Queue.take(closed);
      yield* TestClock.adjust(250);
      expect(yield* Queue.take(opened)).toBe(third);
      yield* Queue.offer(feed, live([]));
      expect(yield* Queue.take(closed)).toBe(third);
      yield* Effect.sync(() => observer.current?.onKey("q"));
      yield* Fiber.join(worker);
      expect(terminal.stdin.isRaw).toBe(false);
    }).pipe(Effect.provide(eventsPlatform)),
);
