import { open as openFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema, Scope } from "effect";
import { ChildProcess } from "effect/process";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/config";
import { commandResult } from "../src/core/preflight/command";
import * as Store from "../src/core/runs/store";
import { computeWorktreeFields } from "../src/core/runs/worktree";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { main } from "../src/main";
import { AppLayer } from "../src/runtime";
import * as Codex from "../src/schemas/codex";
import * as D from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { makeSupervisor } from "../src/supervisor";
import { noAnswer, preamble, timeUp } from "../src/supervisor/prompts";
import { type Rule, Scenario, type Step } from "./fixtures/fake-app-server/scenario";
import { repoHooks, successfulTurn } from "./fixtures/fake-app-server/scenarios";

const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));
const name = Schema.decodeUnknownSync(D.RunName)("unit");
const q1 = Schema.decodeUnknownSync(D.QuestionId)("q1");
const platform = Layer.mergeAll(
  NodeServices.layer,
  DaemonSockets.layer({
    connect: (path) => NodeSocket.makeNet({ path }),
    listen: (path) => NodeSocketServer.make({ path }),
  }),
  Host.layer({
    name: "forman",
    version: "test",
    platform: "node",
    compiled: false,
    executable: [process.execPath],
    pid: process.pid,
  }),
);
const turn = (status: string, items: unknown[] = []) => ({
  id: "{{turn}}",
  status,
  error: null,
  items,
});
const notify = (method: string, params: unknown): Step => ({ notify: method, params });
const complete = (status = "completed", items: unknown[] = []) =>
  notify(Codex.Method.turnCompleted, { threadId: "{{thread}}", turn: turn(status, items) });
const started = () =>
  notify(Codex.Method.turnStarted, { threadId: "{{thread}}", turn: turn("inProgress") });
const message = (text: string, phase = "final_answer") => ({
  type: "agentMessage",
  id: "msg-{{seq}}",
  text,
  phase,
});
const question = (
  label = "q",
  args: unknown = { question: "Which path?", kind: "blocked" },
): Step => ({
  request: Codex.Method.toolCall,
  label,
  params: {
    threadId: "{{thread}}",
    turnId: "{{turn}}",
    callId: `call-${label}`,
    namespace: null,
    tool: "ask_orchestrator",
    arguments: args,
  },
});
const turnRule = (steps: Step[] = []): Rule => ({
  method: Codex.Method.turnStart,
  respond: { result: { turn: { status: "inProgress", error: null, items: [] } } },
  steps: [started(), ...steps],
});
const opened = {
  model: "gpt-6.1-sol",
  serviceTier: "priority",
  cwd: "/tmp",
  sandbox: { type: "readOnly", networkAccess: false },
};
const scenario = (...rules: Rule[]): Scenario => ({
  rules: [
    { method: Codex.Method.threadStart, repeat: true, respond: { result: opened } },
    {
      method: Codex.Method.threadResume,
      repeat: true,
      respond: { result: { ...opened, thread: { id: "{{thread}}" } } },
    },
    ...rules,
  ],
});
const LogMessage = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Codex.RpcError),
});

const fixture = Effect.fnUntraced(function* (script: Scenario) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-s-" }),
  );
  const dataDir = `${root}/d`;
  const repo = `${root}/repo`;
  const worktree = `${repo}/work/unit`;
  const log = `${root}/received.jsonl`;
  const scenarioFile = `${root}/scenario.json`;
  yield* fs.makeDirectory(repo);
  const git = (cwd: string, args: string[]) =>
    commandResult(ChildProcess.make("git", args, { cwd, stderr: "ignore" })).pipe(
      Effect.tap(({ code }) => Effect.sync(() => expect(code).toBe(0))),
    );
  yield* git(repo, ["init", "-q"]);
  yield* git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  yield* git(repo, ["worktree", "add", "-qb", "unit", worktree]);
  yield* fs.writeFileString(
    scenarioFile,
    Schema.encodeSync(Schema.fromJsonString(Scenario))(script),
  );
  yield* fs.writeFileString(log, "");
  const env = {
    HOME: root,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_HOME: `${root}/codex`,
    CODEX_BIN: fake,
    FORMAN_DATA_DIR: dataDir,
    FAKE_APP_SERVER_SCENARIO: scenarioFile,
    FAKE_APP_SERVER_LOG: log,
  };
  const request = (body: D.DaemonRequestBody) => call(body, { dataDir, connectOnly: true });
  const ready = Effect.gen(function* () {
    while (true) {
      const ping = yield* request({ _tag: "Ping" }).pipe(Effect.result);
      if (ping._tag === "Success") return ping.success;
      yield* Effect.yieldNow;
    }
  });
  const launch = Effect.fnUntraced(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const supervisor = yield* makeSupervisor().pipe(
      Effect.provide(AppConfig.layer(env)),
      Scope.provide(scope),
    );
    const fiber = yield* Effect.raceFirst(
      supervisor.failed,
      daemon({ dataDir, version: "test", ...supervisor }),
    ).pipe(Effect.forkIn(scope));
    yield* ready;
    return { supervisor, stop: Scope.close(scope, Exit.void), fiber };
  });
  const start = (extra: Partial<Extract<D.DaemonRequestBody, { _tag: "Start" }>> = {}) =>
    request({
      _tag: "Start",
      name,
      worktree,
      contract: "Do the work.\n- May change: `result.txt`",
      write: false,
      skipDepsCheck: false,
      ...extra,
    });
  const wait = (extra: Partial<Extract<D.DaemonRequestBody, { _tag: "Wait" }>> = {}) =>
    request({
      _tag: "Wait",
      names: [name],
      all: false,
      cwd: worktree,
      timeoutMs: 2000,
      ...extra,
    }).pipe(
      Effect.map((result) => {
        if (result._tag !== "Waited") assert.fail("expected Waited");
        return result;
      }),
    );
  const status = (runName = name) =>
    request({ _tag: "Status", name: runName, cwd: worktree }).pipe(
      Effect.map((result) => {
        if (result._tag !== "Digests") assert.fail("expected Digests");
        const digest = result.digests[0];
        assert.isDefined(digest);
        return digest;
      }),
    );
  const untilState = Effect.fnUntraced(function* (state: D.RunState) {
    while (true) {
      const digest = yield* status();
      if (digest.state === state) return digest;
      yield* Effect.yieldNow;
    }
  });
  const readLog = fs.readFileString(log).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(LogMessage))(line)),
    ),
  );
  const awaitLog = Effect.fnUntraced(function* (method: string, count = 1) {
    while ((yield* readLog).filter((entry) => entry.method === method).length < count)
      yield* Effect.yieldNow;
  });
  const hooks = Effect.gen(function* () {
    yield* fs.makeDirectory(`${repo}/.codex`, { recursive: true });
    const file = `${repo}/.codex/hooks.json`;
    yield* fs.writeFileString(
      scenarioFile,
      Schema.encodeSync(Schema.fromJsonString(Scenario))({
        rules: [...repoHooks(worktree, file).rules, ...script.rules],
      }),
    );
    yield* fs.writeFileString(
      file,
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] },
      }),
    );
  });
  return {
    fs,
    root,
    repo,
    worktree,
    dataDir,
    env,
    log,
    scenarioFile,
    git,
    launch,
    request,
    ready,
    start,
    wait,
    status,
    untilState,
    readLog,
    awaitLog,
    hooks,
    runDir: `${dataDir}/runs/unit`,
  };
});

describe("supervisor over the real daemon socket", () => {
  it.live.each(["notification", "request"])(
    "review: archive invalidates a queued Codex %s and public reads without stopping other runs",
    (kind) =>
      Effect.gen(function* () {
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const late: Step =
          kind === "notification"
            ? notify("late", { threadId: "unit-thread" })
            : {
                ...question("late"),
                params: {
                  threadId: "unit-thread",
                  turnId: "old-turn",
                  callId: "late",
                  namespace: null,
                  tool: "ask_orchestrator",
                  arguments: { question: "Too late?" },
                },
              };
        const barrier: Step[] =
          kind === "notification"
            ? [
                { request: "barrier", label: "barrier", params: {} },
                { awaitResponse: "barrier" },
                { stderr: "barrier" },
              ]
            : [notify("barrier", { threadId: "other-thread" })];
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "unit-thread" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "other-thread" } } },
            },
            turnRule([complete()]),
            turnRule(),
            {
              method: Codex.Method.turnSteer,
              respond: { result: { turnId: "{{turn}}" } },
              steps: [
                late,
                ...barrier,
                ...(kind === "request" ? [{ awaitResponse: "late" }] : []),
                notify("after-late", { threadId: "other-thread" }),
              ],
            },
          ],
        });
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        const { supervisor, fiber } = yield* f.launch();
        yield* f.start();
        yield* f.untilState("idle");
        yield* f.start({ name: otherName, worktree: other });
        const file = `${f.runDir}/run.json`;
        const original = yield* f.fs.readFileString(file);
        yield* f.fs.remove(file);
        expect((yield* commandResult(ChildProcess.make("mkfifo", [file]))).code).toBe(0);
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* Effect.acquireRelease(
              Effect.promise(() => openFile(file, "w")),
              (handle) => Effect.promise(() => handle.close()),
            );
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            yield* Effect.promise(() => handle.writeFile(original));
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const archiving = yield* f.request({ _tag: "Archive", name }).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const reads: D.DaemonRequestBody[] = [
          { _tag: "Status", name, cwd: f.repo },
          { _tag: "Result", name },
          { _tag: "Events", name },
          { _tag: "Wait", names: [name], all: false, cwd: f.repo, timeoutMs: 100 },
        ];
        const queued = yield* Effect.forEach(reads, (body) =>
          supervisor.handler(body).pipe(Effect.flip, Effect.forkChild({ startImmediately: true })),
        );
        const groupStatus = yield* supervisor
          .handler({ _tag: "Status", cwd: f.repo })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const groupWait = yield* supervisor
          .handler({ _tag: "Wait", names: [], all: true, cwd: f.repo, timeoutMs: 100 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* f.request({ _tag: "Steer", name: otherName, message: "send late callback" });
        const marker =
          kind === "notification"
            ? `${f.dataDir}/logs/app-server.log`
            : `${f.dataDir}/runs/other/codex.jsonl`;
        while (!(yield* f.fs.exists(marker))) yield* Effect.yieldNow;
        while (!(yield* f.fs.readFileString(marker)).includes("barrier")) yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        expect(yield* Fiber.join(archiving)).toMatchObject({ _tag: "Archived" });
        yield* Effect.raceFirst(
          Fiber.join(fiber),
          Effect.gen(function* () {
            while (
              !(yield* f.fs.readFileString(`${f.dataDir}/runs/other/codex.jsonl`)).includes(
                "after-late",
              )
            )
              yield* Effect.yieldNow;
          }),
        );
        for (const read of queued)
          expect(yield* Fiber.join(read)).toMatchObject({ _tag: "RunNotFound" });
        expect(yield* Fiber.join(groupStatus)).toMatchObject({
          digests: [{ name: otherName, state: "running" }],
        });
        expect(yield* Fiber.join(groupWait)).toMatchObject({
          _tag: "Waited",
          outcome: "timeout",
          runs: [],
        });
        expect((yield* f.status(otherName)).state).toBe("running");
        expect(yield* f.request({ _tag: "Ping" })).toMatchObject({ _tag: "Pong" });
        expect(yield* f.request({ _tag: "Status", cwd: f.repo })).toMatchObject({
          digests: [{ name: otherName, state: "running" }],
        });
      }).pipe(Effect.provide(platform)),
  );

  it.live("archives only inactive runs, removes group membership and permits name reuse", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), turnRule([complete()]), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      yield* f.launch();
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunNotFound",
      });
      yield* f.start();
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
      });
      expect(yield* f.fs.exists(f.runDir)).toBe(true);
      yield* f.request({ _tag: "Interrupt", name });
      yield* f.untilState("interrupted");
      const original = yield* f.fs.readFileString(`${f.runDir}/run.json`);
      const archived = yield* f.request({ _tag: "Archive", name });
      if (archived._tag !== "Archived") assert.fail("expected Archived");
      expect(archived.archivePath).toMatch(/\/runs\/\.archive\/unit-[0-9]+$/);
      expect(yield* f.fs.readFileString(`${archived.archivePath}/run.json`)).toBe(original);
      expect(yield* f.fs.exists(f.runDir)).toBe(false);
      expect(yield* f.request({ _tag: "Status", cwd: f.repo })).toEqual({
        _tag: "Digests",
        digests: [],
      });
      expect(
        yield* f.request({ _tag: "Status", name, cwd: f.repo }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunNotFound" });
      expect(yield* f.wait({ cwd: f.repo, all: true, names: [] })).toMatchObject({
        outcome: "none",
        runs: [],
      });
      yield* f.start();
      expect((yield* f.untilState("idle")).name).toBe(name);
    }).pipe(Effect.provide(platform)),
  );

  it.live("keeps completed digests after git removes the worktree and refuses followup", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* f.fs.writeFileString(`${f.worktree}/result.txt`, "done");
      const before = yield* f.status();
      yield* f.git(f.repo, ["worktree", "remove", "--force", f.worktree]);
      // Confirm the original failure starts in the platform's process spawn, before mapping.
      expect(yield* computeWorktreeFields(f.worktree, f.runDir).pipe(Effect.flip)).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "NotFound" },
      });
      const expected = {
        filesWritten: before.filesWritten,
        newInGitStatus: before.newInGitStatus,
        outsideMayChange: before.outsideMayChange,
        warnings: [...before.warnings, `worktree removed: ${f.worktree}`],
      };
      expect(yield* f.status()).toMatchObject(expected);
      expect(yield* f.request({ _tag: "Status", cwd: f.repo })).toMatchObject({
        digests: [expected],
      });
      expect(yield* f.wait({ cwd: f.repo, all: true, names: [] })).toMatchObject({
        runs: [{ kind: "done", digest: expected }],
      });
      expect(yield* f.request({ _tag: "Result", name })).toMatchObject({ digest: expected });
      expect(
        yield* f.request({ _tag: "Followup", name, message: "continue" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining("no longer exists") });
    }).pipe(Effect.provide(platform)),
  );

  it.live("reports missing worktrees with null fields after daemon recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      const first = yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* first.stop;
      yield* f.git(f.repo, ["worktree", "remove", f.worktree]);
      yield* f.launch();
      expect(yield* f.status()).toMatchObject({
        filesWritten: null,
        newInGitStatus: null,
        outsideMayChange: null,
        warnings: expect.arrayContaining([`worktree removed: ${f.worktree}`]),
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["platform", "schema"])("explains %s failures reading run data", (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      if (kind === "platform") yield* f.fs.remove(`${f.runDir}/baseline.txt`);
      else
        yield* f.fs.writeFileString(`${f.runDir}/questions.jsonl`, "secret=private invalid JSON\n");
      const error = yield* f.status().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DaemonUnavailable",
        detail: expect.stringContaining("run data"),
      });
      expect(JSON.stringify(error)).not.toContain("private");
    }).pipe(Effect.provide(platform)),
  );

  it.live("explains a Codex request refusal without exposing its message", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario({
          method: Codex.Method.threadStart,
          respond: { error: { code: -1, message: "secret=private" } },
        }),
      );
      yield* f.launch();
      const error = yield* f.start().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CodexUnavailable",
        detail: expect.stringContaining("Codex refused"),
      });
      expect(JSON.stringify(error)).not.toContain("private");
    }).pipe(Effect.provide(platform)),
  );

  it.live("identifies an invalid Codex reply as CodexUnavailable", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario({
          method: Codex.Method.turnStart,
          respond: { result: { turn: { status: 123, error: null, items: [] } } },
        }),
      );
      yield* f.launch();
      const error = yield* f.start().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CodexUnavailable",
        detail: expect.stringContaining("reply"),
      });
      expect(JSON.stringify(error)).not.toContain("private");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: initialization failure closes the failed app-server scope", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const wrapper = `${f.root}/held-initialize`,
        entered = `${f.root}/init-entered`,
        closed = `${f.root}/init-closed`;
      yield* f.fs.writeFileString(
        wrapper,
        `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("generate-json-schema")) fs.writeFileSync(process.argv.at(-1) + "/schema.json", "{}");
else {
  const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(fake)}, ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "inherit"] });
  process.stdin.pipe(child.stdin); child.stdout.on("data", () => {});
  fs.writeFileSync(${JSON.stringify(entered)}, "ready");
  process.on("SIGTERM", () => { child.kill(); fs.writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(0); });
}
`,
        { mode: 0o755 },
      );
      f.env.CODEX_BIN = wrapper;
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.flip, Effect.forkChild);
      while (!(yield* f.fs.exists(entered))) yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(pending);
      expect(yield* f.fs.exists(closed)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: retiring a server cannot lose a replacement server's run", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), turnRule(), turnRule(), {
          method: Codex.Method.turnSteer,
          respond: { result: { turnId: "{{turn}}" } },
          steps: [{ exit: 17 }],
        }),
      );
      const otherName = Schema.decodeUnknownSync(D.RunName)("other"),
        freshName = Schema.decodeUnknownSync(D.RunName)("fresh");
      const other = `${f.repo}/work/other`,
        fresh = `${f.repo}/work/fresh`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      yield* f.git(f.repo, ["worktree", "add", "-qb", "fresh", fresh]);
      yield* f.launch();
      yield* f.start();
      yield* f.start({ name: otherName, worktree: other });
      const baseline = `${f.runDir}/baseline.txt`,
        original = yield* f.fs.readFileString(baseline);
      yield* f.fs.remove(baseline);
      expect((yield* commandResult(ChildProcess.make("mkfifo", [baseline]))).code).toBe(0);
      const held = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const writer = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* Effect.acquireRelease(
            Effect.promise(() => openFile(baseline, "w")),
            (handle) => Effect.promise(() => handle.close()),
          );
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
          yield* Effect.promise(() => handle.writeFile(original));
        }),
      ).pipe(Effect.forkChild);
      const status = yield* f.status().pipe(Effect.forkChild);
      yield* Deferred.await(held);
      yield* f.request({ _tag: "Steer", name: otherName, message: "crash" });
      let openedFresh = false;
      for (let attempt = 0; attempt < 5 && !openedFresh; attempt++) {
        const start = yield* f.start({ name: freshName, worktree: fresh }).pipe(Effect.result);
        openedFresh = start._tag === "Success";
      }
      expect(openedFresh).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      yield* Fiber.join(status);
      while ((yield* f.status(otherName)).state !== "lost") yield* Effect.yieldNow;
      expect((yield* f.wait({ names: [freshName], timeoutMs: 50 })).outcome).toBe("timeout");
      expect((yield* f.status(freshName)).state).toBe("running");
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: a duplicate daemon leaves the owner's active record intact", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      yield* f.launch();
      yield* f.start();
      const before = yield* f.fs.readFileString(`${f.runDir}/run.json`);
      const app = AppLayer(
        f.env,
        false,
        async () => {},
        async () => {},
      );
      expect(yield* main(["daemon"]).pipe(Effect.provide(app))).toBe(0);
      expect(yield* f.fs.readFileString(`${f.runDir}/run.json`)).toBe(before);
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: an unavailable log sink does not stop the daemon", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const app = AppLayer(
        { ...f.env, FORMAN_LOG_FILE: `${f.scenarioFile}/blocked/log`, LOG_LEVEL: "debug" },
        false,
        async () => {},
        async () => {},
      );
      const pending = yield* main(["daemon"]).pipe(Effect.provide(app), Effect.forkScoped);
      const outcome = yield* Effect.raceFirst(
        f.ready.pipe(Effect.as("ready")),
        Fiber.join(pending).pipe(Effect.as("stopped")),
      );
      expect(outcome).toBe("ready");
      yield* f.request({ _tag: "Status", cwd: f.repo });
      expect(yield* f.request({ _tag: "Ping" })).toMatchObject({ _tag: "Pong" });
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: a stalled protocol check is bounded and leaves a warning", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      const wrapper = `${f.root}/probe-wrapper`,
        marker = `${f.root}/probe-entered`;
      yield* f.fs.writeFileString(
        wrapper,
        `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("generate-json-schema")) { fs.writeFileSync(${JSON.stringify(marker)}, "ready"); setInterval(() => {}, 1000); }
else { require("node:child_process").spawn(process.execPath, [${JSON.stringify(fake)}, ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", code => process.exit(code ?? 1)); }
`,
        { mode: 0o755 },
      );
      f.env.CODEX_BIN = wrapper;
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.forkChild);
      while (!(yield* f.fs.exists(marker))) yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const outcome = yield* TestClock.withLive(
        Fiber.join(pending).pipe(Effect.timeoutOption("1 second")),
      );
      expect(outcome._tag).toBe("Some");
      if (outcome._tag === "Some")
        expect((yield* f.status()).warnings).toContain(
          "Could not check the Codex protocol; compatibility is unverified.",
        );
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: existing questions are routed while another thread start is slow", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([{ awaitRequest: Codex.Method.threadStart }, question()])),
      );
      const other = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      // Insert a deliberately held second thread/start before the reusable thread rule.
      const script = scenario(turnRule([{ awaitRequest: Codex.Method.threadStart }, question()]));
      const first = script.rules[0];
      assert.isDefined(first);
      yield* f.fs.writeFileString(
        f.scenarioFile,
        JSON.stringify({
          rules: [
            { ...first, repeat: false },
            { method: Codex.Method.threadStart, respond: "none" },
            ...script.rules.slice(2),
          ],
        }),
      );
      yield* f.launch();
      yield* f.start();
      const pending = yield* f
        .start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree: other })
        .pipe(Effect.forkChild);
      const waited = yield* f.wait({ timeoutMs: 200 });
      expect(waited.runs).toMatchObject([{ kind: "question" }]);
      yield* Fiber.interrupt(pending);
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: disconnecting a Start caller preserves the accepted lifecycle operation", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const first = scenario().rules[0];
      assert.isDefined(first);
      yield* f.fs.writeFileString(
        f.scenarioFile,
        JSON.stringify({ rules: [{ ...first, respond: "none" }] }),
      );
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.forkChild);
      yield* f.awaitLog(Codex.Method.threadStart);
      yield* Fiber.interrupt(pending);
      yield* TestClock.adjust("180 seconds");
      expect((yield* f.status()).state).toBe("unknown");
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.status()).state).toBe("lost");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: null-turn notifications cannot disable unknown recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario({
          method: Codex.Method.turnStart,
          respond: "none",
          steps: [
            { sleepMs: 250 },
            notify(Codex.Method.hookStarted, {
              threadId: "{{thread}}",
              turnId: null,
              run: {
                id: "hook",
                eventName: "SessionStart",
                source: "project",
                sourcePath: "/hooks",
                status: "running",
                entries: [],
              },
            }),
          ],
        }),
      );
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.flip, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.turnStart);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(pending);
      while (!(yield* f.fs.exists(`${f.runDir}/codex.jsonl`))) yield* Effect.yieldNow;
      while (!(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).includes("SessionStart"))
        yield* Effect.yieldNow;
      expect((yield* f.status()).state).toBe("unknown");
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.status()).state).toBe("lost");
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: hook failure retains worktree ownership until completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            notify(Codex.Method.itemStarted, {
              threadId: "{{thread}}",
              turnId: "{{turn}}",
              item: { type: "commandExecution", id: "command" },
            }),
          ]),
          { method: Codex.Method.turnInterrupt, respond: { result: {} } },
          turnRule(),
        ),
      );
      yield* f.hooks;
      const { supervisor } = yield* f.launch();
      yield* f.start();
      yield* f.awaitLog(Codex.Method.turnInterrupt);
      yield* f.request({ _tag: "Events", name });
      expect(yield* supervisor.busy).toBe(true);
      expect(
        yield* f
          .start({ name: Schema.decodeUnknownSync(D.RunName)("replacement") })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict" });
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: rejected budget interrupts stay local to their run", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), {
          method: Codex.Method.turnInterrupt,
          respond: { error: { code: -1, message: "already completed" } },
        }),
      );
      const { fiber } = yield* f.launch();
      yield* f.start({ budgetMs: 1000 });
      yield* TestClock.adjust(1000);
      const outcome = yield* Effect.raceFirst(
        f.request({ _tag: "Ping" }).pipe(Effect.as("alive")),
        Fiber.await(fiber).pipe(Effect.as("stopped")),
      );
      expect(outcome).toBe("alive");
      expect((yield* f.status()).state).toBe("unknown");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: handoff rejection does not lose another active run", () =>
    Effect.gen(function* () {
      const otherName = Schema.decodeUnknownSync(D.RunName)("other");
      const firstTurn: Rule = {
        ...turnRule(),
        respond: {
          result: { turn: { id: "primary-turn", status: "inProgress", error: null, items: [] } },
        },
      };
      const script = scenario(
        firstTurn,
        turnRule(),
        {
          method: Codex.Method.turnStart,
          respond: { error: { code: -1, message: "cannot start" } },
        },
        {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [
            notify(Codex.Method.turnCompleted, {
              threadId: "primary",
              turn: { id: "primary-turn", status: "interrupted", error: null, items: [] },
            }),
          ],
        },
      );
      const f = yield* fixture({
        ...script,
        rules: [
          {
            method: Codex.Method.threadStart,
            respond: { result: { ...opened, thread: { id: "primary" } } },
          },
          ...script.rules,
        ],
      });
      const other = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      yield* f.launch();
      yield* f.start({ budgetMs: 1000 });
      yield* f.start({ name: otherName, worktree: other });
      yield* TestClock.adjust(1000);
      yield* f.untilState("failed");
      expect((yield* f.status(otherName)).state).toBe("running");
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["done", "question"] as const)(
    "returns ready %s attention with fresh worktree fields even at zero wait timeout",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([kind === "done" ? complete() : question()])));
        yield* f.launch();
        yield* f.start();
        yield* f.untilState(kind === "done" ? "idle" : "waiting");
        yield* f.fs.writeFileString(`${f.worktree}/result.txt`, "written after cached status");
        const waited = yield* f.wait({ timeoutMs: 0 });
        expect(waited.outcome).toBe("events");
        expect(waited.runs).toMatchObject([
          { kind, digest: { filesWritten: ["result.txt"], newInGitStatus: ["?? result.txt"] } },
        ]);
      }).pipe(Effect.provide(platform)),
  );

  it.live("review: constructor is a valid run name in wait cursors", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      const constructorName = Schema.decodeUnknownSync(D.RunName)("constructor");
      yield* f.start({ name: constructorName });
      while ((yield* f.status(constructorName)).state !== "idle") yield* Effect.yieldNow;
      expect((yield* f.wait({ names: [constructorName], timeoutMs: 10 })).runs).toMatchObject([
        { kind: "done" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: an old cursor cannot hide attention from a replacement run", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()]), turnRule([question()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      const old = yield* f.wait();
      yield* f.start();
      yield* f.untilState("waiting");
      expect((yield* f.wait({ after: old.cursor, timeoutMs: 10 })).runs).toMatchObject([
        { kind: "question" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: completion summaries use each turn's own status", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()]), turnRule([complete("failed")])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* f.request({ _tag: "Followup", name, message: "second" });
      yield* f.untilState("failed");
      const waited = yield* f.wait();
      expect(waited.runs.map((entry) => [entry.kind, entry.summary])).toEqual([
        ["failed", "turn 2"],
      ]);
    }).pipe(Effect.provide(platform)),
  );
  it.live(
    "checks protocol lazily once, warns on every start, and chooses the cached default model",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()]), turnRule([complete()])));
        const probe = `${f.root}/probe.log`;
        const wrapper = `${f.root}/codex-wrapper`;
        yield* f.fs.writeFileString(
          wrapper,
          `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("generate-json-schema")) {
  fs.appendFileSync(${JSON.stringify(probe)}, "check\\n");
  fs.writeFileSync(process.argv.at(-1) + "/schema.json", "{}");
} else {
  const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(fake)}, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", code => process.exit(code ?? 1));
}
`,
          { mode: 0o755 },
        );
        f.env.CODEX_BIN = wrapper;
        yield* f.fs.makeDirectory(f.env.CODEX_HOME);
        yield* f.fs.writeFileString(
          `${f.env.CODEX_HOME}/models_cache.json`,
          JSON.stringify({ models: [{ slug: "gpt-9.2-sol", visibility: "list" }] }),
        );
        yield* f.launch();
        expect(yield* f.fs.exists(probe)).toBe(false);
        yield* f.start();
        const first = yield* f.untilState("idle");
        expect(first).toMatchObject({
          model: "gpt-9.2-sol",
          warnings: [expect.stringContaining("protocol differs")],
        });
        yield* f.start();
        expect((yield* f.untilState("idle")).warnings).toEqual(first.warnings);
        expect(yield* f.fs.readFileString(probe)).toBe("check\n");
      }).pipe(Effect.provide(platform)),
  );

  it.live("cancels a question when the app server exits while it is held", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question(), { awaitRequest: Codex.Method.threadStart }, { exit: 17 }])),
      );
      const { supervisor } = yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      const other = `${f.repo}/work/crash-trigger`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "crash-trigger", other]);
      yield* f
        .start({ name: Schema.decodeUnknownSync(D.RunName)("trigger"), worktree: other })
        .pipe(Effect.result);
      yield* f.untilState("lost");
      expect(yield* supervisor.busy).toBe(false);
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked" },
        { resolution: "cancelled" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("reports a failed turn with its failure hint and cancels its questions", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            question(),
            { awaitResponse: "q", timeoutMs: 100 },
            notify(Codex.Method.turnCompleted, {
              threadId: "{{thread}}",
              turn: {
                ...turn("failed"),
                error: { message: "rate limited", codexErrorInfo: "rateLimitExceeded" },
              },
            }),
          ]),
        ),
      );
      yield* f.launch();
      yield* f.start();
      const asked = yield* f.wait();
      const ended = yield* f.wait({ after: asked.cursor });
      expect(ended.runs).toMatchObject([
        {
          kind: "failed",
          digest: {
            state: "failed",
            failure: { message: "rate limited", hint: "transient" },
            questions: [],
          },
        },
      ]);
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked" },
        { resolution: "cancelled" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("refuses a follow-up after its worktree has been removed", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* f.git(f.repo, ["worktree", "remove", f.worktree]);
      expect(
        yield* f.request({ _tag: "Followup", name, message: "continue" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict" });
    }).pipe(Effect.provide(platform)),
  );
  it.live("fails closed even when a commandExecution item's detailed shape has changed", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            notify(Codex.Method.itemStarted, {
              threadId: "{{thread}}",
              turnId: "{{turn}}",
              item: { type: "commandExecution", id: "cmd", newCommandField: "true" },
            }),
          ]),
          {
            method: Codex.Method.turnInterrupt,
            respond: { result: {} },
            steps: [complete("interrupted")],
          },
        ),
      );
      yield* f.hooks;
      yield* f.launch();
      yield* f.start();
      while (!(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).includes("newCommandField"))
        yield* Effect.yieldNow;
      const digest = yield* f.status();
      expect(digest.failure?.message).toBe("repo hooks did not run");
    }).pipe(Effect.provide(platform)),
  );
  it.effect(
    "reconciles a timed-out turn from a late notification and still enforces its budget",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            {
              method: Codex.Method.turnStart,
              respond: "none",
              steps: [
                { sleepMs: 250 },
                notify(Codex.Method.turnStarted, {
                  threadId: "{{thread}}",
                  turn: { id: "late-turn", status: "inProgress" },
                }),
              ],
            },
            turnRule([complete("completed", [message("late handoff")])]),
            {
              method: Codex.Method.turnInterrupt,
              respond: { result: {} },
              steps: [
                notify(Codex.Method.turnCompleted, {
                  threadId: "{{thread}}",
                  turn: { id: "late-turn", status: "interrupted" },
                }),
              ],
            },
          ),
        );
        yield* f.launch();
        const pending = yield* f.start({ budgetMs: 60_000 }).pipe(Effect.flip, Effect.forkChild);
        yield* f.awaitLog(Codex.Method.turnStart);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "CodexUnavailable" });
        expect((yield* f.status()).state).toBe("unknown");
        yield* f.untilState("running");
        yield* TestClock.adjust("31 seconds");
        // A socket round trip observes any budget mutation queued by the clock adjustment.
        yield* f.status();
        expect(
          (yield* f.readLog).some((entry) => entry.method === Codex.Method.turnInterrupt),
        ).toBe(true);
      }).pipe(Effect.provide(platform)),
  );

  it.live("refuses follow-up when another active run has reused its worktree", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()]), turnRule(), turnRule()));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("replacement") });
      expect(
        yield* f.request({ _tag: "Followup", name, message: "collide" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining("replacement") });
    }).pipe(Effect.provide(platform)),
  );
  it.live(
    "marks active runs lost on a crash, resumes with saved settings, and warns about questions",
    () =>
      Effect.gen(function* () {
        const script = scenario(
          turnRule([{ awaitRequest: Codex.Method.turnSteer }, { exit: 17 }]),
          { method: Codex.Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } },
        );
        const crashScript = {
          ...script,
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "saved-thread" } } },
            },
            ...script.rules.slice(1),
          ],
        };
        const f = yield* fixture(crashScript);
        const { supervisor } = yield* f.launch();
        yield* f.start({ write: true, model: "explicit-model", effort: "medium", tier: "flex" });
        yield* f.request({ _tag: "Steer", name, message: "crash now" });
        yield* f.untilState("lost");
        expect(yield* supervisor.busy).toBe(false);
        expect((yield* f.wait()).runs).toMatchObject([{ kind: "lost" }]);
        yield* f.fs.writeFileString(
          f.scenarioFile,
          JSON.stringify({
            rules: [
              {
                method: Codex.Method.threadResume,
                respond: { result: { ...opened, thread: { id: "saved-thread" } } },
              },
              turnRule([complete("completed", [message("resumed")])]),
            ],
          }),
        );
        yield* f.request({ _tag: "Followup", name, message: "continue" });
        const digest = yield* f.untilState("idle");
        expect(digest.warnings).toContain(
          "Thread resumed: questions may not reach Claude in this turn.",
        );
        expect(
          (yield* f.readLog).find((entry) => entry.method === Codex.Method.threadResume)?.params,
        ).toEqual({
          threadId: "saved-thread",
          cwd: f.worktree,
          model: "explicit-model",
          serviceTier: "flex",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
      }).pipe(Effect.provide(platform)),
  );

  it.live(
    "rebuilds the registry, cancels pending questions and marks an abandoned active run lost",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([question()])));
        const first = yield* f.launch();
        yield* f.start();
        yield* f.untilState("waiting");
        yield* first.stop;
        const second = yield* f.launch();
        expect((yield* f.status()).state).toBe("lost");
        expect(yield* second.supervisor.busy).toBe(false);
        expect((yield* f.wait()).runs).toMatchObject([{ kind: "lost" }]);
        expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
          { _tag: "Asked" },
          { resolution: "cancelled" },
        ]);
      }).pipe(Effect.provide(platform)),
  );

  it.live("limits unnamed status and wait-all to the caller's repo group", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        rules: successfulTurn().rules.map((rule) => ({ ...rule, repeat: true })),
      });
      const other = yield* fixture(scenario());
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      const otherName = Schema.decodeUnknownSync(D.RunName)("other");
      yield* f.start({ name: otherName, worktree: other.worktree });
      while ((yield* f.status(otherName)).state !== "idle") yield* Effect.yieldNow;
      const status = yield* f.request({ _tag: "Status", cwd: f.worktree });
      expect(status).toMatchObject({ digests: [{ name }] });
      const waited = yield* f.wait({ all: true, names: [] });
      expect(waited.runs.map((outcome) => outcome.name)).toEqual([name]);
      const outside = yield* f.wait({ all: true, names: [], cwd: f.root });
      expect(outside).toMatchObject({ outcome: "none", runs: [] });
      expect(yield* f.request({ _tag: "Status", cwd: f.root })).toEqual({
        _tag: "Digests",
        digests: [],
      });
      const otherWait = yield* f.wait({ all: true, names: [], cwd: other.repo });
      expect(otherWait.runs.map((outcome) => outcome.name)).toEqual([otherName]);
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "keeps the cursor unchanged on timeout and rejects malformed cursors and missing names",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([question()])));
        yield* f.launch();
        yield* f.start();
        const asked = yield* f.wait();
        const timed = yield* f.wait({ after: asked.cursor, timeoutMs: 10 });
        expect(timed).toEqual({
          _tag: "Waited",
          outcome: "timeout",
          runs: [],
          cursor: asked.cursor,
        });
        expect(
          yield* f
            .wait({ after: Schema.decodeUnknownSync(D.Cursor)("not a cursor") })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "Usage" });
        expect(yield* f.wait({ names: [] }).pipe(Effect.flip)).toMatchObject({ _tag: "Usage" });
        expect(
          yield* f
            .request({ _tag: "Result", name: Schema.decodeUnknownSync(D.RunName)("absent") })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "RunNotFound" });
        expect(
          yield* f
            .request({
              _tag: "Answer",
              name,
              question: Schema.decodeUnknownSync(D.QuestionId)("q9"),
              text: "absent",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "RunNotFound" });
      }).pipe(Effect.provide(platform)),
  );

  it.live(
    "rejects malformed question arguments, unknown tools and other server requests without hanging",
    () =>
      Effect.gen(function* () {
        const unknown = question("other");
        if (!("params" in unknown)) assert.fail("expected request");
        const f = yield* fixture(
          scenario(
            turnRule([
              question("bad", { question: 3 }),
              { awaitResponse: "bad" },
              {
                request: Codex.Method.toolCall,
                label: "other",
                params: {
                  threadId: "{{thread}}",
                  turnId: "{{turn}}",
                  callId: "other",
                  namespace: null,
                  tool: "unexpected",
                  arguments: {},
                },
              },
              { awaitResponse: "other" },
              { request: "unexpected", label: "server", params: {} },
              { awaitResponse: "server" },
              complete(),
            ]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("idle");
        expect(
          (yield* f.readLog).filter((entry) => entry.error).map((entry) => entry.error?.code),
        ).toEqual([-32602, -32601, -32601]);
        expect(yield* Store.readQuestions(f.runDir)).toEqual([]);
      }).pipe(Effect.provide(platform)),
  );

  it.live("keeps running while parallel questions remain and allocates IDs across turns", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            question("a"),
            question("b"),
            { awaitResponse: "a" },
            { awaitResponse: "b" },
            complete(),
          ]),
          turnRule([question("c")]),
        ),
      );
      yield* f.launch();
      yield* f.start();
      while ((yield* f.status()).questions.length < 2) yield* Effect.yieldNow;
      yield* f.request({ _tag: "Answer", name, question: q1, text: "one" });
      expect(yield* f.status()).toMatchObject({ state: "waiting", questions: [{ id: "q2" }] });
      yield* f.request({
        _tag: "Answer",
        name,
        question: Schema.decodeUnknownSync(D.QuestionId)("q2"),
        text: "two",
      });
      yield* f.untilState("idle");
      yield* f.request({ _tag: "Followup", name, message: "ask again" });
      expect(yield* f.untilState("waiting")).toMatchObject({ questions: [{ id: "q3" }] });
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "falls back to minimal turn notifications and records unknown methods without losing completion",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([
              notify("new/method", { threadId: "{{thread}}", value: 1 }),
              notify(Codex.Method.tokenUsageUpdated, { threadId: "{{thread}}", bad: true }),
              notify(Codex.Method.turnCompleted, {
                threadId: "{{thread}}",
                turn: { id: "{{turn}}", status: "completed", items: "changed upstream" },
              }),
            ]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("idle");
        expect((yield* f.wait()).runs).toMatchObject([{ kind: "done" }]);
        const events = yield* Store.readEvents(f.runDir);
        expect(events.events).toContainEqual(
          expect.objectContaining({ event: { _tag: "Other", method: "new/method" } }),
        );
        expect(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).toContain("changed upstream");
      }).pipe(Effect.provide(platform)),
  );

  it.effect(
    "marks a timed-out thread start unknown, refuses a duplicate, then loses it after five minutes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          rules: [{ method: Codex.Method.threadStart, respond: "none" }],
        });
        const { supervisor } = yield* f.launch();
        const pending = yield* f.start().pipe(Effect.flip, Effect.forkChild);
        yield* f.awaitLog(Codex.Method.threadStart);
        yield* TestClock.adjust("180 seconds");
        expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "CodexUnavailable" });
        expect((yield* f.status()).state).toBe("unknown");
        expect(yield* supervisor.busy).toBe(true);
        expect(yield* f.start().pipe(Effect.flip)).toMatchObject({ _tag: "RunConflict" });
        yield* TestClock.adjust("5 minutes");
        expect((yield* f.status()).state).toBe("lost");
        expect(yield* supervisor.busy).toBe(false);
      }).pipe(Effect.provide(platform)),
  );

  it.live.each([false, true])(
    "serves Ping through the real daemon CLI parser, log override=%s",
    (override) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario());
        const logFile = override
          ? `${f.root}/custom-daemon.jsonl`
          : `${f.dataDir}/logs/daemon.jsonl`;
        const app = AppLayer(
          { ...f.env, ...(override ? { FORMAN_LOG_FILE: logFile } : {}), LOG_LEVEL: "debug" },
          false,
          async () => {},
          async () => {},
        );
        const pending = yield* main(["daemon"]).pipe(Effect.provide(app), Effect.forkScoped);
        expect(yield* f.ready).toMatchObject({ _tag: "Pong", version: "test" });
        yield* f.request({ _tag: "Status", cwd: f.repo });
        while (!(yield* f.fs.exists(logFile))) yield* Effect.yieldNow;
        while (!(yield* f.fs.readFileString(logFile)).includes("daemon.connection.closed"))
          yield* Effect.yieldNow;
        expect(yield* f.fs.readFileString(logFile)).toContain("daemon.connection.closed");
        yield* Fiber.interrupt(pending);
        expect(yield* f.fs.exists(`${f.dataDir}/forman.sock`)).toBe(false);
      }).pipe(Effect.provide(platform)),
  );
  it.live(
    "starts with the tool and prompt, records events/tokens/handoff, and respects the wait cursor",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(successfulTurn());
        const { supervisor } = yield* f.launch();
        expect(yield* supervisor.busy).toBe(false);
        const result = yield* f.start({ effort: "xhigh", write: true });
        expect(result).toEqual({ _tag: "Started", name, runDir: f.runDir });
        yield* f.untilState("idle");
        const waited = yield* f.wait();
        expect(waited.runs).toMatchObject([
          {
            name,
            kind: "done",
            summary: "turn 1",
            digest: {
              state: "idle",
              effort: "xhigh",
              sandbox: "danger-full-access",
              filesWritten: [],
              newInGitStatus: [],
              commands: { total: 1 },
            },
          },
        ]);
        expect(waited.runs[0]?.digest.tokens?.input).toBeGreaterThan(0);
        expect(yield* f.wait({ all: true, after: waited.cursor })).toMatchObject({
          outcome: "none",
          runs: [],
          cursor: waited.cursor,
        });
        const log = yield* f.readLog;
        const thread = Schema.decodeUnknownSync(Codex.ThreadStartParams)(
          log.find((entry) => entry.method === Codex.Method.threadStart)?.params,
        );
        expect(thread).toMatchObject({
          cwd: f.worktree,
          model: "gpt-6.1-sol",
          serviceTier: "priority",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: false,
          dynamicTools: [Codex.askOrchestratorTool],
        });
        const first = Schema.decodeUnknownSync(Codex.TurnStartParams)(
          log.find((entry) => entry.method === Codex.Method.turnStart)?.params,
        );
        expect(first).toMatchObject({
          effort: "xhigh",
          sandboxPolicy: { type: "dangerFullAccess" },
        });
        expect(first.input[0]?.text).toBe(
          `${preamble}\n\nDo the work.\n- May change: \`result.txt\``,
        );
        const record = yield* Store.readRun(f.runDir);
        expect(record).toMatchObject({
          group: f.repo,
          state: "idle",
          turns: 1,
          activeTurnId: null,
        });
        expect(record.baseCommit).toMatch(/^[a-f0-9]{40}$/);
        const events = yield* f.request({ _tag: "Events", name, after: 0, limit: 100 });
        if (events._tag !== "Events") assert.fail("expected Events");
        expect(events.events.map((entry) => entry.event._tag)).toEqual(
          expect.arrayContaining([
            "TurnStarted",
            "TurnCompleted",
            "Command",
            "FileChange",
            "TokenUsage",
            "AgentMessage",
          ]),
        );
        expect(events.events.map((entry) => entry.seq)).toEqual(events.events.map((_, i) => i + 1));
        expect(yield* f.request({ _tag: "Events", name, after: events.next })).toMatchObject({
          events: [],
          gap: false,
          next: events.next,
        });
        expect(yield* f.request({ _tag: "Result", name })).toMatchObject({
          handoff: { turn: 1, text: "Created result.txt." },
          latestTurnWithoutHandoff: false,
        });
        expect(yield* f.fs.readFileString(`${f.runDir}/turns/1.md`)).toBe("Created result.txt.");
        expect(yield* supervisor.busy).toBe(false);
      }).pipe(Effect.provide(platform)),
  );

  it.live("refreshes worktree fields when wait wakes on a question after status", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([{ awaitRequest: Codex.Method.turnSteer }, question()]), {
          method: Codex.Method.turnSteer,
          respond: { result: { turnId: "{{turn}}" } },
        }),
      );
      yield* f.launch();
      yield* f.start();
      expect(yield* f.status()).toMatchObject({ filesWritten: [], newInGitStatus: [] });
      const waiting = yield* Effect.forkScoped(f.wait());
      yield* f.fs.writeFileString(`${f.worktree}/result.txt`, "changed after status");
      yield* f.fs.writeFileString(`${f.worktree}/outside.txt`, "outside the contract");
      yield* f.request({ _tag: "Steer", name, message: "ask now" });
      expect((yield* Fiber.join(waiting)).runs).toMatchObject([
        {
          kind: "question",
          digest: {
            filesWritten: ["outside.txt", "result.txt"],
            outsideMayChange: ["outside.txt"],
            newInGitStatus: ["?? outside.txt", "?? result.txt"],
          },
        },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("only reports a missing handoff as ended after the active turn finishes", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question()]), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      yield* f.launch();
      yield* f.start();
      const asked = yield* f.wait();
      expect(yield* f.request({ _tag: "Result", name })).toMatchObject({
        digest: { state: "waiting" },
        handoff: null,
        latestTurnWithoutHandoff: false,
      });
      yield* f.request({ _tag: "Interrupt", name });
      yield* f.wait({ after: asked.cursor });
      expect(yield* f.request({ _tag: "Result", name })).toMatchObject({
        digest: { state: "interrupted" },
        handoff: null,
        latestTurnWithoutHandoff: true,
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live("refuses starts and followups after shutdown is accepted", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      const { supervisor } = yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      // Keep the listener alive to exercise requests queued behind the shutdown decision.
      expect(yield* supervisor.handler({ _tag: "Shutdown" })).toEqual({ _tag: "Ok" });
      for (const request of [f.start(), f.request({ _tag: "Followup", name, message: "too late" })])
        expect(yield* request.pipe(Effect.flip)).toMatchObject({
          _tag: "RunConflict",
          detail: expect.stringContaining("stopping"),
        });
      expect((yield* f.status()).state).toBe("idle");
    }).pipe(Effect.provide(platform)),
  );

  it.live("refuses Shutdown with active run names, then shuts down once inactive", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      const { fiber } = yield* f.launch();
      yield* f.start();
      expect(yield* f.request({ _tag: "Shutdown" }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining("unit"),
      });
      expect((yield* f.status()).state).toBe("running");
      yield* f.request({ _tag: "Interrupt", name });
      yield* f.untilState("interrupted");
      expect(yield* f.request({ _tag: "Shutdown" })).toEqual({ _tag: "Ok" });
      yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"));
      expect(yield* f.fs.exists(`${f.dataDir}/forman.sock`)).toBe(false);
      expect(yield* f.fs.exists(`${f.dataDir}/daemon.lock`)).toBe(false);
    }).pipe(Effect.provide(platform)),
  );

  it.live("computes shell-written files and git status at completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([{ awaitRequest: Codex.Method.turnSteer }, complete()]), {
          method: Codex.Method.turnSteer,
          respond: { result: { turnId: "{{turn}}" } },
        }),
      );
      const { supervisor } = yield* f.launch();
      yield* f.start();
      expect(yield* supervisor.busy).toBe(true);
      yield* f.fs.writeFileString(`${f.worktree}/result.txt`, "written outside a fileChange item");
      yield* f.request({ _tag: "Steer", name, message: "finish" });
      expect(yield* f.untilState("idle")).toMatchObject({
        filesWritten: ["result.txt"],
        newInGitStatus: ["?? result.txt"],
        outsideMayChange: [],
      });
      expect(
        yield* f.request({ _tag: "Steer", name, message: "late" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining("followup") });
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "refuses active name and worktree conflicts and archives a valid inactive replacement",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(turnRule(), turnRule([complete()]), {
            method: Codex.Method.turnInterrupt,
            respond: { result: {} },
            steps: [complete("interrupted")],
          }),
        );
        yield* f.launch();
        yield* f.start();
        expect(yield* f.start().pipe(Effect.flip)).toMatchObject({ _tag: "RunConflict" });
        expect(
          yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("other") }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "RunConflict" });
        expect(
          yield* f.request({ _tag: "Followup", name, message: "wrong" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "RunConflict" });
        yield* f.request({ _tag: "Interrupt", name });
        yield* f.untilState("interrupted");
        const old = yield* f.fs.readFileString(`${f.runDir}/run.json`);
        yield* f.start({ contract: "replacement" });
        yield* f.untilState("idle");
        const archives = yield* f.fs.readDirectory(`${f.dataDir}/runs/.archive`);
        expect(archives).toHaveLength(1);
        expect(
          yield* f.fs.readFileString(`${f.dataDir}/runs/.archive/${archives[0]}/run.json`),
        ).toBe(old);
        expect(yield* f.fs.readFileString(`${f.runDir}/contract.md`)).toBe("replacement");
      }).pipe(Effect.provide(platform)),
  );

  it.live("passes preflight error classes through the socket", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      yield* f.launch();
      for (const worktree of [f.root, f.repo, `${f.worktree}/missing`])
        expect(yield* f.start({ worktree }).pipe(Effect.flip)).toMatchObject({
          _tag: "WorktreeInvalid",
        });
      yield* f.fs.makeDirectory(`${f.worktree}/nested`);
      expect(yield* f.start({ worktree: `${f.worktree}/nested` }).pipe(Effect.flip)).toMatchObject({
        _tag: "WorktreeInvalid",
        detail: expect.stringContaining("Rule 1"),
      });
      const outside = `${f.root}/outside`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "outside", outside]);
      expect(yield* f.start({ worktree: outside }).pipe(Effect.flip)).toMatchObject({
        _tag: "WorktreeInvalid",
        detail: expect.stringContaining("Rule 3"),
      });
      yield* f.fs.writeFileString(`${f.worktree}/package.json`, "{}");
      expect(yield* f.start().pipe(Effect.flip)).toMatchObject({
        _tag: "WorktreeInvalid",
        detail: expect.stringContaining("Rule 4"),
      });
      yield* f.hooks;
      yield* f.fs.writeFileString(
        f.scenarioFile,
        Schema.encodeSync(Schema.fromJsonString(Scenario))({
          rules: [...repoHooks(f.worktree, `${f.repo}/.codex/hooks.json`, "untrusted").rules],
        }),
      );
      expect(yield* f.start({ skipDepsCheck: true }).pipe(Effect.flip)).toMatchObject({
        _tag: "RepoHooksUntrusted",
      });
      expect(yield* f.fs.exists(f.runDir)).toBe(false);
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["trusted", "untrusted"])("checks %s hook trust before creating a run", (status) =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.hooks;
      yield* f.fs.writeFileString(
        f.scenarioFile,
        Schema.encodeSync(Schema.fromJsonString(Scenario))({
          rules: [
            ...repoHooks(f.worktree, `${f.repo}/.codex/hooks.json`, status).rules,
            ...scenario(turnRule([complete()])).rules,
          ],
        }),
      );
      yield* f.launch();
      if (status === "trusted") {
        expect(yield* f.start()).toMatchObject({ _tag: "Started" });
        yield* f.untilState("idle");
      } else {
        expect(yield* f.start().pipe(Effect.flip)).toMatchObject({
          _tag: "RepoHooksUntrusted",
          detail: expect.stringContaining(
            `${f.repo}/.codex/hooks.json:pre_tool_use:0:0: untrusted`,
          ),
        });
        expect(yield* f.fs.exists(f.runDir)).toBe(false);
        expect((yield* f.readLog).some((entry) => entry.method === Codex.Method.threadStart)).toBe(
          false,
        );
      }
    }).pipe(Effect.provide(platform)),
  );

  it.live("holds questions, refuses steer, answers once, and returns to running", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            question(),
            { awaitResponse: "q" },
            { awaitRequest: Codex.Method.turnSteer },
            complete(),
          ]),
          { method: Codex.Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } },
        ),
      );
      const { supervisor } = yield* f.launch();
      yield* f.start();
      const waited = yield* f.wait();
      expect(waited.runs).toMatchObject([
        { kind: "question", summary: "q1 (blocked): Which path?", digest: { state: "waiting" } },
      ]);
      expect(yield* supervisor.busy).toBe(true);
      expect(
        yield* f.request({ _tag: "Steer", name, message: "change" }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "RunConflict",
        detail: "answer q1 first; the answer can carry the change",
      });
      yield* f.request({ _tag: "Answer", name, question: q1, text: "Take path A" });
      expect((yield* f.status()).state).toBe("running");
      expect(
        yield* f.request({ _tag: "Answer", name, question: q1, text: "twice" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict" });
      yield* f.request({ _tag: "Steer", name, message: "finish" });
      expect((yield* f.wait({ after: waited.cursor })).runs).toMatchObject([{ kind: "done" }]);
      expect(yield* f.readLog).toContainEqual({
        result: { success: true, contentItems: [{ type: "inputText", text: "Take path A" }] },
      });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked", id: "q1", turn: 1 },
        { _tag: "Resolved", resolution: "answered", text: "Take path A" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.effect("auto-answers on the question timeout through TestClock", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question(), { awaitResponse: "q" }, complete()])),
      );
      yield* f.launch();
      yield* f.start({ questionTimeoutMs: 1000 });
      yield* f.untilState("waiting");
      yield* TestClock.adjust(1000);
      yield* f.untilState("idle");
      expect(yield* f.readLog).toContainEqual({
        result: { success: true, contentItems: [{ type: "inputText", text: noAnswer }] },
      });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked" },
        { resolution: "auto-answered", text: noAnswer },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("cancels held questions on interrupt and refuses a later answer", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question()]), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      const { supervisor } = yield* f.launch();
      yield* f.start();
      const asked = yield* f.wait();
      yield* f.request({ _tag: "Interrupt", name });
      expect((yield* f.wait({ after: asked.cursor })).runs).toMatchObject([
        { kind: "interrupted" },
      ]);
      expect(yield* supervisor.busy).toBe(false);
      expect(
        yield* f.request({ _tag: "Answer", name, question: q1, text: "late" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RunConflict" });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked" },
        { resolution: "cancelled", text: null },
      ]);
      expect(yield* f.readLog).not.toContainEqual(
        expect.objectContaining({ result: { success: true, contentItems: expect.anything() } }),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["activeTurnNotSteerable", "unsafe secret=should-not-escape"])(
    "maps Codex steer refusal %s to a safe conflict",
    (error) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(turnRule(), {
            method: Codex.Method.turnSteer,
            respond: { error: { code: -1, message: error } },
          }),
        );
        yield* f.launch();
        yield* f.start();
        const conflict = yield* f
          .request({ _tag: "Steer", name, message: "change" })
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "RunConflict",
          detail: expect.stringContaining(
            error === "activeTurnNotSteerable" ? error : "Codex refused",
          ),
        });
        expect("detail" in conflict && conflict.detail).not.toContain("should-not-escape");
      }).pipe(Effect.provide(platform)),
  );

  it.live(
    "starts follow-up turn 2 and preserves the previous handoff after an empty interrupt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(turnRule([complete("completed", [message("first handoff")])]), turnRule(), {
            method: Codex.Method.turnInterrupt,
            respond: { result: {} },
            steps: [complete("interrupted")],
          }),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("idle");
        yield* f.request({ _tag: "Followup", name, message: "continue", effort: "medium" });
        expect(yield* f.status()).toMatchObject({
          turn: 2,
          turnKind: "followup",
          effort: "medium",
          state: "running",
        });
        expect(yield* f.request({ _tag: "Result", name })).toMatchObject({
          handoff: { turn: 1, text: "first handoff" },
          latestTurnWithoutHandoff: false,
        });
        yield* f.request({ _tag: "Interrupt", name });
        yield* f.untilState("interrupted");
        expect(yield* f.request({ _tag: "Result", name })).toMatchObject({
          handoff: { turn: 1, text: "first handoff" },
          latestTurnWithoutHandoff: true,
        });
        const starts = (yield* f.readLog).filter(
          (entry) => entry.method === Codex.Method.turnStart,
        );
        expect(starts[1]?.params).toMatchObject({
          effort: "medium",
          input: [{ type: "text", text: "continue" }],
        });
        expect(
          (yield* f.readLog).filter((entry) => entry.method === Codex.Method.threadResume),
        ).toHaveLength(0);
      }).pipe(Effect.provide(platform)),
  );

  it.effect(
    "interrupts on budget expiry, obtains a read-only handoff, and restores sandbox on follow-up",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([question()]),
            turnRule([complete("completed", [message("time-up handoff")])]),
            turnRule(),
            {
              method: Codex.Method.turnInterrupt,
              repeat: true,
              respond: { result: {} },
              steps: [complete("interrupted")],
            },
          ),
        );
        const { supervisor } = yield* f.launch();
        yield* f.start({ write: true, budgetMs: 1000 });
        const asked = yield* f.wait();
        yield* TestClock.adjust(1000);
        yield* f.untilState("interrupted");
        expect(yield* supervisor.busy).toBe(false);
        expect(yield* Store.readRun(f.runDir)).toMatchObject({
          turnKind: "handoff",
          restoreSandbox: true,
          turns: 2,
        });
        expect(yield* f.request({ _tag: "Result", name })).toMatchObject({
          handoff: { turn: 2, text: "time-up handoff" },
        });
        expect((yield* f.wait({ after: asked.cursor })).runs.at(-1)).toMatchObject({
          kind: "interrupted",
          summary: "turn 2",
        });
        expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
          { _tag: "Asked" },
          { resolution: "cancelled" },
        ]);
        yield* f.request({ _tag: "Followup", name, message: "continue writing" });
        expect(yield* Store.readRun(f.runDir)).toMatchObject({
          restoreSandbox: false,
          turnKind: "followup",
        });
        const starts = (yield* f.readLog).filter(
          (entry) => entry.method === Codex.Method.turnStart,
        );
        expect(starts[1]?.params).toMatchObject({
          input: [{ text: timeUp }],
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        });
        expect(starts[2]?.params).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
      }).pipe(Effect.provide(platform)),
  );

  it.live.each([false, true])("enforces the repo-hook rule, project hook seen=%s", (hookSeen) =>
    Effect.gen(function* () {
      const command = notify(Codex.Method.itemStarted, {
        threadId: "{{thread}}",
        turnId: "{{turn}}",
        item: {
          type: "commandExecution",
          id: "cmd",
          command: "true",
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
        },
      });
      const hook = notify(Codex.Method.hookStarted, {
        threadId: "{{thread}}",
        turnId: "{{turn}}",
        run: {
          id: "hook",
          eventName: "PreToolUse",
          source: "project",
          sourcePath: "/hooks.json",
          status: "running",
          entries: [],
        },
      });
      const steps = hookSeen ? [hook, command, complete()] : [command];
      const f = yield* fixture(
        scenario(turnRule(steps), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      yield* f.hooks;
      yield* f.launch();
      yield* f.start();
      expect(yield* f.untilState(hookSeen ? "idle" : "failed")).toMatchObject({
        failure: hookSeen ? null : { message: "repo hooks did not run" },
      });
      if (!hookSeen) {
        yield* f.awaitLog(Codex.Method.turnInterrupt);
        expect((yield* Store.readEvents(f.runDir)).events).toContainEqual(
          expect.objectContaining({ event: { _tag: "Interrupted", by: "repo-hooks" } }),
        );
      }
    }).pipe(Effect.provide(platform)),
  );
  it.live("keeps the previous inactive run intact when a replacement fails preflight", () =>
    Effect.gen(function* () {
      const f = yield* fixture(successfulTurn());
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      const before = yield* f.fs.readFileString(`${f.runDir}/run.json`);
      expect(yield* f.start({ worktree: f.repo }).pipe(Effect.flip)).toMatchObject({
        _tag: "WorktreeInvalid",
      });
      expect(yield* f.fs.readFileString(`${f.runDir}/run.json`)).toBe(before);
      expect(yield* f.fs.exists(`${f.dataDir}/runs/.archive`)).toBe(false);
      expect((yield* f.status()).state).toBe("idle");
    }).pipe(Effect.provide(platform)),
  );
});
