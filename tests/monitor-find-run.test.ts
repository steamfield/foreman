import { Writable } from "node:stream";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { expect } from "vitest";
import type { Message } from "../src/core/monitor/model";
import { type FindRequests, runFind } from "../src/tui/find-executor";
import { ndjson, runCli, tempDir } from "./helpers/cli";

it("preserves the history request id and defect trace in the real diagnostic log", async () => {
  const home = await tempDir();
  const log = join(home, "cli.jsonl");
  const result = await runCli(["monitor"], {
    home,
    env: { TEST_CLI_LOG_FILE: log },
    program: runFind(
      () => Effect.die(new Error("disk unavailable")),
      Stream.make({ history: { id: 7 }, clipboard: null }),
      () => {},
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    ),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  const records = ndjson(await readFile(log, "utf8"));
  expect(records).toEqual([
    expect.objectContaining({
      msg: "monitor.history.failed",
      historyId: 7,
      trace: expect.stringContaining("monitor-find-run.test.ts"),
    }),
  ]);
  expect(JSON.stringify(records)).not.toContain("disk unavailable");
});

it.effect("reads each new history id once and replies with that id", () =>
  Effect.gen(function* () {
    const ids: number[] = [];
    const messages: Message[] = [];
    yield* runFind(
      () =>
        Effect.sync(() => {
          ids.push(1);
          return { entries: [], skipped: 2 };
        }),
      Stream.make(
        { history: { id: 1 }, clipboard: null },
        { history: { id: 1 }, clipboard: null },
        { history: { id: 2 }, clipboard: null },
      ),
      (message) => messages.push(message),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    );
    expect(ids).toEqual([1, 1]);
    expect(messages).toEqual([
      { type: "history-result", id: 1, entries: [], error: null, skipped: 2 },
      { type: "history-result", id: 2, entries: [], error: null, skipped: 2 },
    ]);
  }),
);
it.effect("keeps a stale history reply tagged with its own id", () =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<FindRequests>();
    const messages = yield* Queue.unbounded<Message>();
    const first = yield* Deferred.make<{
      readonly entries: readonly [];
      readonly skipped: number;
    }>();
    let calls = 0;
    const fiber = yield* Effect.forkChild(
      runFind(
        () => (++calls === 1 ? Deferred.await(first) : Effect.succeed({ entries: [], skipped: 0 })),
        Stream.fromQueue(requests),
        (message) => {
          Queue.offerUnsafe(messages, message);
        },
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      ),
    );
    yield* Queue.offer(requests, { history: { id: 1 }, clipboard: null });
    yield* Queue.offer(requests, { history: { id: 2 }, clipboard: null });
    expect(yield* Queue.take(messages)).toEqual({
      type: "history-result",
      id: 2,
      entries: [],
      error: null,
      skipped: 0,
    });
    yield* Deferred.succeed(first, { entries: [], skipped: 0 });
    expect(yield* Queue.take(messages)).toEqual({
      type: "history-result",
      id: 1,
      entries: [],
      error: null,
      skipped: 0,
    });
    yield* Fiber.interrupt(fiber);
  }),
);
it.effect("turns a history reader defect into an error reply, including a synchronous throw", () =>
  Effect.gen(function* () {
    for (const reader of [
      () => Effect.die(new Error("disk unavailable")),
      () => {
        throw new Error("disk unavailable");
      },
    ]) {
      const messages: Message[] = [];
      yield* runFind(
        reader,
        Stream.make({ history: { id: 7 }, clipboard: null }),
        (message) => messages.push(message),
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      );
      expect(messages).toEqual([
        {
          type: "history-result",
          id: 7,
          entries: null,
          skipped: 0,
          error: expect.stringContaining("disk unavailable"),
        },
      ]);
    }
  }),
);
it.effect("writes OSC 52 with exact base64 text once per clipboard id regardless of color", () =>
  Effect.gen(function* () {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    const text = "foreman steer 界\n--file <path>";
    const request = { history: null, clipboard: { id: 1, text } };
    yield* runFind(
      () => Effect.succeed({ entries: [], skipped: 0 }),
      Stream.make(request, request, { ...request, clipboard: { id: 2, text } }),
      () => {},
      output,
    );
    expect(chunks).toEqual(
      Array.from({ length: 2 }, () => `\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`),
    );
  }),
);

import { readFile } from "node:fs/promises";
import { join } from "node:path";
