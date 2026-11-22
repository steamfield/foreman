/**
 * Behavior of the shared JSON-RPC channel against a real scripted child process
 * (tests/fixtures/jsonrpc/peer.mjs): routing, ids, timeouts and every way a channel ends.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Effect, Exit, Fiber, FileSystem, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  type ChannelEnd,
  type ChannelOptions,
  openChannel,
  RpcError,
  RpcRequestTimeout,
} from "../../src/providers/jsonrpc";

const peer = fileURLToPath(new URL("../fixtures/jsonrpc/peer.mjs", import.meta.url));

class PeerUnavailable extends Data.TaggedError("PeerUnavailable")<{ readonly end: ChannelEnd }> {}

const failed = (end: Omit<Extract<ChannelEnd, { _tag: "Failed" }>, "_tag">) =>
  new PeerUnavailable({ end: { _tag: "Failed", ...end } });
const closed = new PeerUnavailable({ end: { _tag: "Closed" } });
const Held = Schema.Struct({ id: Schema.Number });

const open = (overrides: Partial<ChannelOptions<PeerUnavailable>> = {}) =>
  openChannel<PeerUnavailable>({
    command: process.execPath,
    args: [peer],
    env: {},
    stderr: () => Effect.void,
    unavailable: (end) => new PeerUnavailable({ end }),
    ...overrides,
  });

type PeerChannel = Effect.Success<ReturnType<typeof open>>;

/** Starts a "hold" request in the background and waits until the peer has seen it. */
const holdRequest = Effect.fnUntraced(function* (
  channel: PeerChannel,
  options?: Parameters<PeerChannel["request"]>[3],
) {
  const pending = yield* channel
    .request("hold", {}, Schema.String, options)
    .pipe(Effect.exit, Effect.forkChild);
  const [holding] = yield* channel.notifications.pipe(Stream.take(1), Stream.runCollect);
  return { pending, id: Schema.decodeUnknownSync(Held)(holding?.params).id };
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("JSON-RPC channel", () => {
  it.effect("round-trips a request and decodes the result with the caller's schema", () =>
    Effect.gen(function* () {
      const channel = yield* open();
      const echoed = yield* channel.request(
        "echo",
        { value: 7, extra: true },
        Schema.Struct({ value: Schema.Number }),
      );
      expect(echoed).toEqual({ value: 7 });
      expect(yield* channel.request("echo", "again", Schema.String)).toBe("again");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("turns an error response into RpcError with its code and message", () =>
    Effect.gen(function* () {
      const channel = yield* open();
      const error = yield* Effect.flip(channel.request("reject", {}, Schema.Unknown));
      expect(error).toBeInstanceOf(RpcError);
      expect(error).toMatchObject({ code: -7, message: "refused" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "routes and buffers notifications and server requests with string and numeric ids",
    () =>
      Effect.gen(function* () {
        const channel = yield* open();
        expect(yield* channel.request("ask", {}, Schema.String)).toBe("asked");
        const requests = yield* channel.serverRequests.pipe(Stream.take(2), Stream.runCollect);
        expect(requests).toEqual([
          { id: "ask-1", method: "question", params: { text: "first" } },
          { id: 9, method: "question" },
        ]);
        yield* channel.respond("ask-1", "yes");
        yield* channel.respondError(9, -32601, "unsupported");
        expect(yield* channel.notifications.pipe(Stream.take(3), Stream.runCollect)).toEqual([
          { method: "asking", params: { step: 1 } },
          { method: "answered", params: { id: "ask-1", result: "yes" } },
          {
            method: "answered",
            params: { id: 9, error: { code: -32601, message: "unsupported" } },
          },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("times out with RpcRequestTimeout and ignores the late reply", () =>
    Effect.gen(function* () {
      const channel = yield* open();
      const held = yield* holdRequest(channel, { timeout: "4 seconds" });
      yield* TestClock.adjust("4 seconds");
      expect(failureOf(yield* Fiber.join(held.pending))).toEqual(
        new RpcRequestTimeout({ method: "hold", timeoutMs: 4000 }),
      );
      yield* channel.request("release", { id: held.id }, Schema.Null);
      yield* channel.notifications.pipe(Stream.take(1), Stream.runDrain);
      expect(yield* channel.request("echo", "still open", Schema.String)).toBe("still open");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits past 30 seconds when the timeout is none", () =>
    Effect.gen(function* () {
      const channel = yield* open();
      const held = yield* holdRequest(channel, { timeout: "none" });
      yield* TestClock.adjust("1 hour");
      expect(held.pending.pollUnsafe()).toBeUndefined();
      yield* channel.request("release", { id: held.id }, Schema.Null);
      expect(yield* Fiber.join(held.pending)).toEqual(Exit.succeed("too late"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ends with Failed on an invalid line and fails pending requests", () =>
    Effect.gen(function* () {
      const channel = yield* open();
      const held = yield* holdRequest(channel);
      const invalid = failed({ reason: "decode", detail: "invalid JSON-RPC message" });
      expect(yield* Effect.flip(channel.request("garbage", {}, Schema.Unknown))).toEqual(invalid);
      expect(failureOf(yield* Fiber.join(held.pending))).toEqual(invalid);
      expect(Cause.squash(yield* channel.termination)).toEqual(invalid);
      expect(yield* channel.notifications.pipe(Stream.runCollect)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ends with Failed naming the exit code and fails pending requests", () =>
    Effect.gen(function* () {
      const channel = yield* open();
      const held = yield* holdRequest(channel);
      const exited = failed({ reason: "exit", detail: "exited with code 3", exitCode: 3 });
      expect(yield* Effect.flip(channel.request("exit", { code: 3 }, Schema.Unknown))).toEqual(
        exited,
      );
      expect(failureOf(yield* Fiber.join(held.pending))).toEqual(exited);
      expect(yield* channel.exitCode).toBe(3);
      expect(Cause.squash(yield* channel.termination)).toEqual(exited);
      expect(yield* channel.notifications.pipe(Stream.runCollect)).toEqual([]);
      expect(yield* channel.serverRequests.pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.flip(channel.request("echo", {}, Schema.Unknown))).toEqual(exited);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("delivers stderr and notifications written just before the child exits", () =>
    Effect.gen(function* () {
      const stderr: string[] = [];
      const channel = yield* open({
        stderr: (line) => Effect.sync(() => stderr.push(line)),
      });
      yield* channel.notify("farewell", { code: 4 });
      expect(yield* channel.notifications.pipe(Stream.runCollect)).toEqual([
        { method: "goodbye", params: { code: 4 } },
      ]);
      expect(Cause.squash(yield* channel.termination)).toEqual(
        failed({ reason: "exit", detail: "exited with code 4", exitCode: 4 }),
      );
      expect(yield* channel.exitCode).toBe(4);
      expect(stderr).toEqual(["leaving with code 4"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("ends with Closed, and no Failed, when the caller's scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const channel = yield* open().pipe(Scope.provide(scope));
      const held = yield* holdRequest(channel);
      yield* Scope.close(scope, Exit.void);
      expect(failureOf(yield* Fiber.join(held.pending))).toEqual(closed);
      expect(Cause.squash(yield* channel.termination)).toEqual(closed);
      expect(yield* channel.notifications.pipe(Stream.runCollect)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with unavailable(Failed) when the executable is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const missing = join(yield* fs.makeTempDirectoryScoped(), "missing");
      const error = yield* Effect.flip(open({ command: missing, args: [] }));
      expect(error.end).toEqual({
        _tag: "Failed",
        reason: "launch",
        detail: expect.stringMatching(
          new RegExp(`^could not launch ${RegExp.escape(JSON.stringify(missing))}: \\S`),
        ),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names the working directory when launching in a missing one fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = join(yield* fs.makeTempDirectoryScoped(), "gone");
      const error = yield* Effect.flip(open({ cwd }));
      expect(error.end).toEqual({
        _tag: "Failed",
        reason: "launch",
        detail: expect.stringContaining(
          `could not launch ${JSON.stringify(process.execPath)} in ${JSON.stringify(cwd)}: `,
        ),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts the child in the given working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const channel = yield* open({ cwd: dir });
      expect(yield* channel.request("cwd", {}, Schema.String)).toBe(dir);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
