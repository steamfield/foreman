import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { checkProtocol, codexVersion, hashSchemas } from "../src/codex/check";
import { CodexRpcError, openConnection } from "../src/codex/client";
import { appServerEnvironment } from "../src/codex/environment";
import * as Codex from "../src/schemas/codex";
import { Scenario } from "./fixtures/fake-app-server/scenario";
import {
  askOrchestrator,
  blockedCommand,
  crash,
  interruptedTurn,
  successfulTurn,
} from "./fixtures/fake-app-server/scenarios";

const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));
const Message = Schema.Struct({
  id: Schema.optionalKey(Codex.RpcId),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Codex.RpcError),
});
const messages = (content: string) =>
  content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Message))(line));
const setup = Effect.fnUntraced(function* (
  scenario: Scenario,
  stderr: (line: string) => Effect.Effect<void> = () => Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const script = join(dir, "scenario.json");
  const log = join(dir, "received.jsonl");
  yield* fs.writeFileString(script, Schema.encodeSync(Schema.fromJsonString(Scenario))(scenario));
  const connection = yield* openConnection({
    codexBin: fake,
    env: {
      PATH: dirname(process.execPath),
      FAKE_APP_SERVER_SCENARIO: script,
      FAKE_APP_SERVER_LOG: log,
    },
    version: "test-version",
    stderr,
  });
  return { ...connection, log, readLog: fs.readFileString(log).pipe(Effect.map(messages)) };
});

const begin = Effect.fnUntraced(function* (client: Effect.Success<ReturnType<typeof setup>>) {
  const thread = yield* client.request(
    Codex.Method.threadStart,
    {
      cwd: "/tmp/fake-repo",
      model: "gpt-6.1-sol",
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      dynamicTools: [],
    },
    Codex.ThreadOpened,
  );
  const turn = yield* client.request(
    Codex.Method.turnStart,
    { threadId: thread.thread.id, input: [{ type: "text", text: "do the test" }] },
    Codex.TurnStartResponse,
  );
  return { threadId: thread.thread.id, turnId: turn.turn.id };
});

describe("app-server environment", () => {
  it.each(["OPENAI_API_KEY", "OPENAI_API_BASE", "CODEX_API_KEY"])(
    "drops %s while preserving unrelated environment",
    (key) => {
      expect(
        appServerEnvironment(
          { [key]: "must-not-pass", PATH: "/bin", OTHER: "keep" },
          { alive: false, launchdSocket: undefined },
        ),
      ).toEqual({ PATH: "/bin", OTHER: "keep", CODEX_DELEGATE: "1", STACKS_DELEGATE: "1" });
    },
  );
  it("drops controlled variables and preserves PATH and unrelated keys", () => {
    expect(
      appServerEnvironment(
        {
          CLAUDE_A: "a",
          CLAUDE_B: "b",
          FORMAN_A: "a",
          FORMAN_B: "b",
          LOG_LEVEL: "debug",
          PATH: "/bin",
          HOME: "/home",
          OTHER: "x",
          UNSET: undefined,
          CODEX_DELEGATE: "0",
          STACKS_DELEGATE: "0",
        },
        { alive: false, launchdSocket: undefined },
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home",
      OTHER: "x",
      CODEX_DELEGATE: "1",
      STACKS_DELEGATE: "1",
    });
  });
  it.each([
    { inherited: undefined, alive: false, expected: "/launchd" },
    { inherited: "/dead", alive: false, expected: "/launchd" },
    { inherited: "/live", alive: true, expected: "/live" },
  ])("selects SSH socket $expected", ({ inherited, alive, expected }) => {
    expect(
      appServerEnvironment({ SSH_AUTH_SOCK: inherited }, { alive, launchdSocket: "/launchd" })
        .SSH_AUTH_SOCK,
    ).toBe(expected);
  });
});

describe("real Node app-server client", () => {
  it.live("fails pending requests on exit even when the stderr sink is blocked", () =>
    Effect.gen(function* () {
      const blocked = yield* Deferred.make<void>();
      const client = yield* setup(
        {
          rules: [
            { method: "held", respond: "none", steps: [{ notify: "ready", params: {} }] },
            {
              method: "crash",
              respond: "none",
              steps: [{ stderr: "still flushing" }, { exit: 17 }],
            },
          ],
        },
        () => Deferred.await(blocked),
      );
      const pending = yield* client
        .request("held", {}, Schema.Unknown)
        .pipe(Effect.flip, Effect.forkChild);
      yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
      const crashRequest = yield* client
        .request("crash", {}, Schema.Unknown)
        .pipe(Effect.flip, Effect.forkChild);
      expect(yield* client.exitCode).toBe(17);
      expect(yield* Fiber.join(pending).pipe(Effect.timeout("500 millis"))).toMatchObject({
        _tag: "CodexUnavailable",
        detail: "app server exited with code 17",
      });
      expect(yield* Fiber.join(crashRequest)).toMatchObject({
        _tag: "CodexUnavailable",
        detail: "app server exited with code 17",
      });
      expect(
        yield* client.notifications.pipe(Stream.runCollect, Effect.timeout("500 millis")),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("propagates background defects through pending requests and inbound streams", () =>
    Effect.gen(function* () {
      const client = yield* setup(
        {
          rules: [
            {
              method: "held",
              respond: "none",
              steps: [
                { notify: "ready", params: {} },
                { awaitRequest: "fault" },
                { stderr: "trigger defect" },
              ],
            },
            { method: "fault", respond: "none" },
          ],
        },
        () => Effect.die("stderr sink defect"),
      );
      const pending = yield* client
        .request("held", {}, Schema.Unknown)
        .pipe(Effect.exit, Effect.forkChild);
      yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
      const fault = yield* client
        .request("fault", {}, Schema.Unknown)
        .pipe(Effect.exit, Effect.forkChild);
      for (const exit of [
        yield* Fiber.join(pending).pipe(Effect.timeout("500 millis")),
        yield* Fiber.join(fault),
        yield* client.notifications.pipe(Stream.runDrain, Effect.exit),
        yield* client.serverRequests.pipe(Stream.runDrain, Effect.exit),
        yield* client.request("later", {}, Schema.Unknown).pipe(Effect.exit),
      ]) {
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(Cause.hasDies(exit.cause));
          expect(Cause.squash(exit.cause)).toBe("stderr sink defect");
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats prototype property method names as unknown methods", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        rules: [{ method: "constructor", respond: { result: "okay" } }],
      });
      expect(yield* client.request("constructor", {}, Schema.String)).toBe("okay");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stores expanded supplied ids for later placeholder substitutions", () =>
    Effect.gen(function* () {
      const success = successfulTurn();
      const client = yield* setup({
        rules: success.rules.map((rule) => {
          if (rule.method === Codex.Method.threadStart)
            return {
              ...rule,
              respond: {
                result: {
                  thread: { id: "thread-{{seq}}" },
                  model: "test",
                  serviceTier: null,
                  cwd: "/tmp",
                  sandbox: { type: "readOnly", networkAccess: false },
                },
              },
            };
          return {
            ...rule,
            respond: {
              result: {
                turn: { id: "turn-{{seq}}", status: "inProgress", items: [], error: null },
              },
            },
          };
        }),
      });
      const ids = yield* begin(client);
      const events = yield* client.notifications.pipe(Stream.take(6), Stream.runCollect);
      expect(ids).toEqual({ threadId: "thread-1", turnId: "turn-2" });
      expect(Schema.decodeUnknownSync(Codex.TurnNotification)(events[0]?.params)).toMatchObject({
        threadId: ids.threadId,
        turn: { id: ids.turnId },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.live("closing the scope kills the child, fails requests and leaves its exit observable", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const client = yield* setup({
        rules: [{ method: "held", respond: "none", steps: [{ notify: "ready", params: {} }] }],
      }).pipe(Scope.provide(scope));
      const pending = yield* client
        .request("held", {}, Schema.Unknown)
        .pipe(Effect.flip, Effect.forkChild);
      yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "CodexUnavailable",
        detail: "app server connection closed",
      });
      // Node's spawner reports signal termination as PlatformError, rather than a numeric code.
      expect(yield* client.exitCode.pipe(Effect.flip, Effect.timeout("500 millis"))).toMatchObject({
        _tag: "CodexUnavailable",
        detail: "could not observe app server exit",
      });
      expect(yield* client.notifications.pipe(Stream.runCollect)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("handshakes before requests and decodes results and typed RPC errors", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        rules: [
          { method: "test", respond: { result: { value: 7, extra: true } } },
          { method: "test", respond: { error: { code: -42, message: "rejected" } } },
        ],
      });
      expect(
        yield* client.request("test", { input: "x" }, Schema.Struct({ value: Schema.Number })),
      ).toEqual({ value: 7 });
      const error = yield* Effect.flip(client.request("test", {}, Schema.Unknown));
      expect(error).toBeInstanceOf(CodexRpcError);
      expect(error).toMatchObject({ code: -42, message: "rejected" });
      const log = yield* client.readLog;
      expect(log.map((entry) => entry.method)).toEqual([
        "initialize",
        "initialized",
        "test",
        "test",
      ]);
      expect(log[0]?.params).toEqual({
        clientInfo: { name: "forman", title: "forman", version: "test-version" },
        capabilities: { experimentalApi: true },
      });
      expect(
        new Set(log.filter((entry) => entry.id !== undefined).map((entry) => entry.id)).size,
      ).toBe(3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("times out with the method and duration using TestClock", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        rules: [{ method: "held", respond: "none", steps: [{ notify: "received", params: {} }] }],
      });
      const request = yield* client
        .request("held", {}, Schema.Unknown, { timeout: "4 seconds" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(request)).toMatchObject({
        _tag: "CodexRequestTimeout",
        method: "held",
        timeoutMs: 4000,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a 30 second default and accepts the 180 second thread/start timeout", () =>
    Effect.gen(function* () {
      for (const test of [
        { method: "default-timeout", params: {}, options: {}, milliseconds: 30000 },
        {
          method: Codex.Method.threadStart,
          params: {
            cwd: "/tmp",
            model: "gpt-6.1-sol",
            serviceTier: "priority",
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
            dynamicTools: [],
          },
          options: { timeout: "180 seconds" as const },
          milliseconds: 180000,
        },
      ]) {
        const client = yield* setup({
          rules: [
            { method: test.method, respond: "none", steps: [{ notify: "received", params: {} }] },
          ],
        });
        const pending = yield* client
          .request(test.method, test.params, Schema.Unknown, test.options)
          .pipe(Effect.flip, Effect.forkChild);
        yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
        yield* TestClock.adjust(test.milliseconds);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "CodexRequestTimeout",
          method: test.method,
          timeoutMs: test.milliseconds,
        });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid known params before sending and invalid decoded results", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        rules: [{ method: "bad-result", respond: { result: { value: "wrong" } } }],
      });
      expect(
        yield* Effect.flip(client.request(Codex.Method.threadStart, {}, Codex.ThreadOpened)),
      ).toMatchObject({ _tag: "SchemaError" });
      expect(
        yield* Effect.flip(
          client.request("bad-result", {}, Schema.Struct({ value: Schema.Number })),
        ),
      ).toMatchObject({ _tag: "SchemaError" });
      expect((yield* client.readLog).map((message) => message.method)).toEqual([
        "initialize",
        "initialized",
        "bad-result",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("matches concurrent requests when the second response arrives first", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        rules: [
          {
            method: "echo",
            when: { value: "first" },
            delayMs: 500,
            respond: { result: "first result" },
            steps: [{ notify: "responded", params: "first" }],
          },
          {
            method: "echo",
            when: { value: "second" },
            respond: { result: "second result" },
            steps: [{ notify: "responded", params: "second" }],
          },
        ],
      });
      const completed: string[] = [];
      const results = yield* Effect.all(
        ["first", "second"].map((value) =>
          client.request("echo", { value }, Schema.String).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed.push(value);
              }),
            ),
          ),
        ),
        { concurrency: 2 },
      );
      expect(results).toEqual(["first result", "second result"]);
      expect(completed).toEqual(["second", "first"]);
      expect(yield* client.notifications.pipe(Stream.take(2), Stream.runCollect)).toEqual([
        { method: "responded", params: "second" },
        { method: "responded", params: "first" },
      ]);
      expect(
        (yield* client.readLog)
          .filter((message) => message.method === "echo")
          .map((message) => message.params),
      ).toEqual([{ value: "first" }, { value: "second" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("matches concurrent numeric ids with notifications between responses", () =>
    Effect.gen(function* () {
      const values = ["first", "second", "third", "fourth"];
      const client = yield* setup({
        rules: values.map((value) => ({
          method: "echo",
          when: { value },
          respond: { result: value },
          steps: [{ notify: "seen", params: value }],
        })),
      });
      expect(
        yield* Effect.all(
          values.map((value) => client.request("echo", { value }, Schema.String)),
          { concurrency: "unbounded" },
        ),
      ).toEqual(values);
      expect(
        yield* client.notifications.pipe(Stream.take(values.length), Stream.runCollect),
      ).toEqual(values.map((params) => ({ method: "seen", params })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("buffers notifications in order and forwards stderr as text", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const client = yield* setup(
        {
          onStart: [
            { notify: "one", params: { n: 1 } },
            { stderr: "plain stderr {not JSON}" },
            { notify: "two", params: [2] },
          ],
          rules: [{ method: "stop", respond: "none", steps: [{ exit: 0 }] }],
        },
        (line) =>
          Effect.sync(() => {
            seen.push(line);
          }),
      );
      expect(yield* client.notifications.pipe(Stream.take(2), Stream.runCollect)).toEqual([
        { method: "one", params: { n: 1 } },
        { method: "two", params: [2] },
      ]);
      yield* client.request("stop", {}, Schema.Unknown).pipe(Effect.flip);
      expect(yield* client.exitCode).toBe(0);
      expect(seen).toEqual(["plain stderr {not JSON}"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps steer responsive while a server tool request is held, then responds", () =>
    Effect.gen(function* () {
      const client = yield* setup(askOrchestrator());
      const ids = yield* begin(client);
      const calls = yield* client.serverRequests.pipe(Stream.take(1), Stream.runCollect);
      const call = calls[0];
      assert.isDefined(call);
      expect(call.method).toBe(Codex.Method.toolCall);
      expect(
        yield* client.request(
          Codex.Method.turnSteer,
          { threadId: ids.threadId, expectedTurnId: ids.turnId, input: [] },
          Codex.TurnSteerResponse,
        ),
      ).toEqual({
        turnId: ids.turnId,
      });
      yield* client.respond(call.id, {
        success: true,
        contentItems: [{ type: "inputText", text: "PINEAPPLE" }],
      });
      yield* client.notifications.pipe(Stream.take(2), Stream.runDrain);
      expect(yield* client.readLog).toContainEqual({
        id: call.id,
        result: { success: true, contentItems: [{ type: "inputText", text: "PINEAPPLE" }] },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("responds to an unexpected server request with an RPC error", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        onStart: [
          { request: "unexpected", label: "x", params: {} },
          { awaitResponse: "x" },
          { notify: "done", params: {} },
        ],
        rules: [],
      });
      const calls = yield* client.serverRequests.pipe(Stream.take(1), Stream.runCollect);
      const call = calls[0];
      assert.isDefined(call);
      yield* client.respondError(call.id, -32601, "unsupported method");
      yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
      expect(yield* client.readLog).toContainEqual({
        id: call.id,
        error: { code: -32601, message: "unsupported method" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails every pending request, drains streams and reports the crash code", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        rules: [
          { method: "held", respond: "none", steps: [{ notify: "ready", params: {} }] },
          ...crash(17).rules,
        ],
      });
      const first = yield* client
        .request("held", {}, Schema.Unknown)
        .pipe(Effect.flip, Effect.forkChild);
      yield* client.notifications.pipe(Stream.take(1), Stream.runDrain);
      const second = yield* client
        .request(Codex.Method.turnStart, { threadId: "thread", input: [] }, Schema.Unknown)
        .pipe(Effect.flip);
      expect(second).toMatchObject({
        _tag: "CodexUnavailable",
        detail: "app server exited with code 17",
      });
      expect(yield* Fiber.join(first)).toEqual(second);
      expect(yield* client.exitCode).toBe(17);
      expect(yield* client.notifications.pipe(Stream.runCollect)).toEqual([]);
      expect(yield* client.serverRequests.pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.flip(client.request("after-exit", {}, Schema.Unknown))).toEqual(second);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("plays a successful turn with command, file change, tokens and final answer", () =>
    Effect.gen(function* () {
      const client = yield* setup(successfulTurn());
      const ids = yield* begin(client);
      for (const id of Object.values(ids))
        expect(id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
      const events = yield* client.notifications.pipe(Stream.take(6), Stream.runCollect);
      expect(events.map((event) => event.method)).toEqual([
        Codex.Method.turnStarted,
        Codex.Method.itemCompleted,
        Codex.Method.itemCompleted,
        Codex.Method.tokenUsageUpdated,
        Codex.Method.itemCompleted,
        Codex.Method.turnCompleted,
      ]);
      const command = Schema.decodeUnknownSync(Codex.ItemNotification)(events[1]?.params);
      expect(command.item.type).toBe("commandExecution");
      expect(Schema.decodeUnknownSync(Codex.ItemNotification)(events[2]?.params).item.type).toBe(
        "fileChange",
      );
      expect(
        Schema.decodeUnknownSync(Codex.TokenUsageNotification)(events[3]?.params).tokenUsage.total
          .totalTokens,
      ).toBeGreaterThan(0);
      expect(
        Schema.decodeUnknownSync(Codex.ItemNotification)(events[4]?.params).item,
      ).toMatchObject({ type: "agentMessage", phase: "final_answer" });
      expect(Schema.decodeUnknownSync(Codex.TurnNotification)(events[5]?.params)).toMatchObject({
        threadId: ids.threadId,
        turn: { id: ids.turnId, status: "completed" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("interrupts a held call and silently ignores its later answer", () =>
    Effect.gen(function* () {
      const client = yield* setup(interruptedTurn());
      const ids = yield* begin(client);
      const calls = yield* client.serverRequests.pipe(Stream.take(1), Stream.runCollect);
      const call = calls[0];
      assert.isDefined(call);
      yield* client.request(Codex.Method.turnInterrupt, ids, Schema.Unknown);
      const events = yield* client.notifications.pipe(Stream.take(2), Stream.runCollect);
      expect(
        Schema.decodeUnknownSync(Codex.ItemNotification)(events[0]?.params).item,
      ).toMatchObject({
        type: "dynamicToolCall",
        status: "failed",
        id: Schema.decodeUnknownSync(Codex.ToolCallParams)(call.params).callId,
      });
      expect(
        Schema.decodeUnknownSync(Codex.TurnNotification)(events[1]?.params).turn,
      ).toMatchObject({ status: "interrupted", items: [] });
      yield* client.respond(call.id, { success: true, contentItems: [] });
      yield* client.request(
        Codex.Method.turnSteer,
        { threadId: ids.threadId, expectedTurnId: ids.turnId, input: [] },
        Codex.TurnSteerResponse,
      );
      expect(yield* client.readLog).toContainEqual({
        id: call.id,
        result: { success: true, contentItems: [] },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("plays the recorded project hook block", () =>
    Effect.gen(function* () {
      const client = yield* setup(blockedCommand());
      yield* begin(client);
      const events = yield* client.notifications.pipe(Stream.take(4), Stream.runCollect);
      expect(Schema.decodeUnknownSync(Codex.HookNotification)(events[1]?.params).run).toMatchObject(
        {
          source: "project",
          status: "blocked",
          entries: [expect.objectContaining({ kind: "feedback" })],
        },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("continues fake steps when awaitRequest and awaitResponse time out", () =>
    Effect.gen(function* () {
      const client = yield* setup({
        onStart: [
          { awaitRequest: "never", timeoutMs: 1 },
          { request: "unanswered", params: {}, label: "unanswered" },
          { awaitResponse: "unanswered", timeoutMs: 1 },
          { notify: "continued", params: { ok: true } },
          { exit: 0 },
        ],
        rules: [],
      });
      expect(yield* client.notifications.pipe(Stream.runCollect)).toEqual([
        { method: "continued", params: { ok: true } },
      ]);
      expect(yield* client.exitCode).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("protocol fingerprint", () => {
  it.effect("maps missing Codex executables to CodexUnavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      expect(
        yield* Effect.flip(checkProtocol(join(dir, "does-not-exist"), { PATH: "/bin" })),
      ).toMatchObject({ _tag: "CodexUnavailable" });
      expect(
        yield* Effect.flip(codexVersion(join(dir, "does-not-exist"), { PATH: "/bin" })),
      ).toMatchObject({ _tag: "CodexUnavailable" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a valid-looking version from a process that exits unsuccessfully", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const executable = join(dir, "codex-version");
      yield* fs.writeFileString(executable, "#!/bin/sh\nprintf 'codex-cli 0.166.0\\n'\nexit 23\n");
      yield* fs.chmod(executable, 0o755);
      expect(yield* Effect.flip(codexVersion(executable, { PATH: "/bin" }))).toMatchObject({
        _tag: "CodexUnavailable",
        detail: "Codex version exited with code 23",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("sorts relative paths and hashes raw bytes with NUL separators", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* Effect.promise(() => mkdir(join(dir, "nested")));
      yield* Effect.promise(() => writeFile(join(dir, "z.json"), "z\n"));
      yield* Effect.promise(() =>
        writeFile(join(dir, "nested/a.json"), new Uint8Array([0, 255, 10])),
      );
      const expected = createHash("sha256")
        .update("nested/a.json\0")
        .update(new Uint8Array([0, 255, 10]))
        .update("\0z.json\0z\n\0")
        .digest("hex");
      expect(yield* hashSchemas(dir)).toEqual({
        matches: false,
        hash: expected,
        files: ["nested/a.json", "z.json"],
      });
      yield* fs.writeFileString(join(dir, "z.json"), "y\n");
      expect((yield* hashSchemas(dir)).hash).not.toBe(expected);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
