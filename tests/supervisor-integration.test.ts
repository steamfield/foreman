import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  References,
  Schema,
  Scope,
} from "effect";
import { ChildProcess } from "effect/process";
import { TestClock } from "effect/testing";
import { openConnection } from "../src/codex/client";
import { AppConfig } from "../src/config";
import { commandResult } from "../src/core/process";
import * as Store from "../src/core/runs/store";
import { computeWorktreeFields } from "../src/core/runs/worktree";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { ErrorEnvelope, RunConflict } from "../src/errors";
import { entry, type LogEntry } from "../src/logging";
import { jsonRequested, main } from "../src/main";
import { AppLayer } from "../src/runtime";
import * as Codex from "../src/schemas/codex";
import * as D from "../src/schemas/daemon";
import { Host } from "../src/services/host";
import { makeSupervisor } from "../src/supervisor";
import { makeAppServer } from "../src/supervisor/app-server";
import { deferral, preamble, timeUp } from "../src/supervisor/prompts";
import { makeQuestions } from "../src/supervisor/questions";
import { makeRegistry } from "../src/supervisor/registry";
import { makeTurns } from "../src/supervisor/turns";
import { type Rule, Scenario, type Step } from "./fixtures/fake-app-server/scenario";
import { repoHooks, successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { runCli } from "./helpers/cli";

const fake = fileURLToPath(new URL("./fixtures/fake-app-server/main.mjs", import.meta.url));
it("limits ask_orchestrator to blockers and consequential decisions, with progress in the hand-off", () => {
  for (const text of [Codex.askOrchestratorTool.description, preamble]) {
    expect(text).toContain("only when blocked");
    expect(text).toContain("decision with real consequences");
    expect(text).toContain("Progress, findings and corrections go in the hand-off");
    expect(text).toContain("every call pauses the turn until answered");
  }
});
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
    build: "test",
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

const fixture = Effect.fnUntraced(function* (script: Scenario, legacy = false, repoName = "repo") {
  const fs = yield* FileSystem.FileSystem;
  const host = yield* Host;
  const daemonHost = Host.layer({ ...host, build: legacy ? "old" : host.build });
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "fm-s-" }),
  );
  const dataDir = `${root}/d`;
  const repo = `${root}/${repoName}`;
  const worktree = `${repo}/work/unit`;
  const log = `${root}/received.jsonl`;
  const scenarioFile = `${root}/scenario.json`;
  yield* fs.makeDirectory(repo);
  yield* fs.symlink(process.execPath, `${root}/forman`);
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
    PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_HOME: `${root}/codex`,
    CODEX_BIN: fake,
    FORMAN_HOME: dataDir,
    FAKE_APP_SERVER_SCENARIO: scenarioFile,
    FAKE_APP_SERVER_LOG: log,
  };
  const request = (body: D.DaemonRequestBody) =>
    call(body, { dataDir, connectOnly: true }).pipe(Effect.provide(daemonHost));
  const cli = Effect.fnUntraced(function* (args: readonly string[]) {
    let stdout = "";
    let stderr = "";
    const status = yield* main(args).pipe(
      Effect.provide(
        AppLayer(
          env,
          jsonRequested(args),
          async (text) => {
            stdout += text;
          },
          async (text) => {
            stderr += text;
          },
        ),
      ),
    );
    const noticeText = "Daemon is outdated; it will be replaced once its runs finish.";
    const notice = `${jsonRequested(args) ? JSON.stringify({ notice: { tag: "DaemonOutdated", message: noticeText } }) : noticeText}\n`;
    expect({ status, stderr }).toEqual({
      status: 0,
      stderr: legacy ? notice.repeat(args.includes("--wait") ? 2 : 1) : "",
    });
    return stdout;
  });
  const nextArgs = (command: string) => {
    const prefix = `FORMAN_HOME=${dataDir} forman `;
    expect(command.startsWith(prefix)).toBe(true);
    return command.slice(prefix.length).split(" ");
  };
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
    const handler = (body: D.DaemonRequestBody) => {
      // An old busy daemon remains in service and acknowledges mutations without a cursor.
      if (legacy && body._tag === "Shutdown")
        return Effect.fail(new RunConflict({ detail: "Active legacy runs" }));
      return supervisor
        .handler(body)
        .pipe(
          Effect.map((result) =>
            legacy && result._tag === "Accepted" ? { _tag: "Ok" as const } : result,
          ),
        );
    };
    const fiber = yield* Effect.raceFirst(
      supervisor.failed,
      daemon({ dataDir, version: "test", ...supervisor, handler }).pipe(Effect.provide(daemonHost)),
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
    cli,
    nextArgs,
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

const preflightFixture = Effect.fnUntraced(function* () {
  const f = yield* fixture(scenario(turnRule()));
  const config = yield* Effect.service(AppConfig).pipe(Effect.provide(AppConfig.layer(f.env)));
  const registry = yield* makeRegistry(f.dataDir);
  const servers = yield* makeAppServer(
    config,
    "test",
    registry,
    () => Effect.void,
    () => Effect.void,
  );
  const turns = yield* makeTurns(registry, servers, config);
  const body = {
    _tag: "Start" as const,
    name,
    worktree: f.repo,
    newWorktree: true,
    contract: "Do the work",
    write: false,
    skipDepsCheck: false,
  };
  return { ...f, registry, turns, body };
});

const queuedAnswersFixture = Effect.fnUntraced(function* () {
  const finished = (id: string, status = "completed") =>
    notify(Codex.Method.turnCompleted, {
      threadId: "primary",
      turn: { id, status, error: null, items: [] },
    });
  const response = (id: string) => ({
    result: { turn: { id, status: "inProgress", error: null, items: [] } },
  });
  const script = scenario(
    { ...turnRule([question(), { awaitResponse: "q" }]), respond: response("work") },
    {
      method: Codex.Method.turnStart,
      respond: response("handoff"),
      steps: [{ awaitRequest: Codex.Method.threadStart }, finished("handoff")],
    },
    ...["A", "B", "C"].map(
      (id): Rule => ({
        method: Codex.Method.turnStart,
        when: { threadId: "primary" },
        respond: response(id),
        steps: [...(id === "C" ? [] : [{ awaitRequest: Codex.Method.threadStart }]), finished(id)],
      }),
    ),
    { ...turnRule([complete()]), repeat: true },
    {
      method: Codex.Method.turnInterrupt,
      respond: { result: {} },
      steps: [finished("work", "interrupted")],
    },
    { method: Codex.Method.turnSteer, repeat: true, respond: { result: { turnId: "A" } } },
  );
  const f = yield* fixture({
    rules: [
      {
        method: Codex.Method.threadStart,
        respond: { result: { ...opened, thread: { id: "primary" } } },
      },
      ...script.rules,
    ],
  });
  let peers = 0;
  const release = Effect.gen(function* () {
    const peer = Schema.decodeUnknownSync(D.RunName)(`peer-${++peers}`);
    const worktree = `${f.repo}/work/${peer}`;
    yield* f.git(f.repo, ["worktree", "add", "-qb", peer, worktree]);
    yield* f.start({ name: peer, worktree });
    yield* f.wait({ names: [peer] });
  });
  const handoff = Effect.gen(function* () {
    yield* f.start({ budgetMs: 1000 });
    yield* f.untilState("waiting");
    yield* f.cli(["defer", "unit", "q1"]);
    yield* TestClock.adjust(1000);
    while ((yield* f.status()).turnKind !== "handoff") yield* Effect.yieldNow;
  });
  const atTurn = (turn: number) =>
    Effect.gen(function* () {
      while ((yield* f.status()).turn < turn) yield* Effect.yieldNow;
    });
  const answer = (text: string) => f.request({ _tag: "Answer", name, question: q1, text });
  return { ...f, release, handoff, atTurn, answer };
});

describe("supervisor over the real daemon socket", () => {
  it.live("review audit: retained managed work never hides a defect", () =>
    Effect.gen(function* () {
      const f = yield* preflightFixture();
      const file = `${f.repo}/.claude/worktrees/unit/retained.txt`;
      Object.defineProperty(f.body, "budgetMs", {
        get() {
          writeFileSync(file, "work");
          throw new TypeError("PRIVATE_DEFECT");
        },
      });
      const result = yield* Effect.promise(() =>
        runCli(["--json"], {
          env: { ...f.env, LOG_LEVEL: "debug" },
          program: f.turns.start(f.body, Effect.void).pipe(Effect.asVoid),
        }),
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("TypeError\\nat ");
      expect(result.stderr).not.toContain("PRIVATE_DEFECT");
      expect(yield* f.fs.readFileString(file)).toBe("work");
    }).pipe(Effect.provide(platform)),
  );
  it.live("review audit: failed protocol probes keep the executable, exit and action", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(f.env.CODEX_BIN);
      expect(result.stdout).toContain("schema generation exited with code 1");
      expect(result.stdout).toContain("Install Codex 0.166.0");
      expect(result.stdout).toContain("forman doctor");
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["permission", "symlink", "reuse"] as const)(
    "review audit: skipped %s metadata stays accurate",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        yield* f.fs.makeDirectory(f.runDir, { recursive: true });
        if (mode === "symlink") {
          yield* f.fs.remove(f.runDir, { recursive: true });
          yield* f.fs.symlink(`${f.root}/absent`, f.runDir);
        } else {
          yield* f.fs.writeFileString(`${f.runDir}/run.json`, "bad JSON");
          if (mode === "permission") yield* f.fs.chmod(`${f.runDir}/run.json`, 0);
        }
        yield* f.launch();
        if (mode === "reuse") {
          yield* f.fs.remove(f.runDir, { recursive: true });
          yield* f.start();
          yield* f.untilState("idle");
          const result = yield* Effect.promise(() =>
            runCli(["status", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
          );
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout).skipped).toBeUndefined();
        } else {
          const result = yield* Effect.promise(() =>
            runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
          );
          expect(result.status).toBe(mode === "permission" ? 6 : 8);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(f.runDir);
          expect(result.stderr).toContain(mode === "permission" ? "permissions" : "inspect");
          if (mode === "permission") yield* f.fs.chmod(`${f.runDir}/run.json`, 0o600);
          yield* f.fs.remove(f.runDir, { recursive: mode !== "symlink" });
          const removed = yield* Effect.promise(() =>
            runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
          );
          expect(removed.status).toBe(7);
          expect(removed.stdout).toBe("");
        }
      }).pipe(Effect.provide(platform)),
  );
  it.live("review audit: live turn failures are redacted in status, result and wait", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            notify(Codex.Method.turnCompleted, {
              threadId: "{{thread}}",
              turn: {
                id: "{{turn}}",
                status: "failed",
                items: [],
                error: { message: "token=PRIVATE_TURN_TOKEN", codexErrorInfo: null },
              },
            }),
          ]),
        ),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("failed");
      for (const args of [
        ["status", "unit"],
        ["result", "unit"],
        ["wait", "unit", "--timeout", "0ms"],
      ]) {
        const result = yield* Effect.promise(() =>
          runCli([...args, "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("[redacted]");
        expect(result.stdout).not.toContain("PRIVATE_TURN_TOKEN");
      }
    }).pipe(Effect.provide(platform)),
  );
  it.effect("review audit: hook query timeouts remain Codex failures", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ method: Codex.Method.hooksList, respond: "none" }));
      yield* f.fs.makeDirectory(`${f.repo}/.codex`);
      yield* f.fs.writeFileString(`${f.repo}/.codex/hooks.json`, "{}");
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.result, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.hooksList);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(pending);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CodexUnavailable", detail: expect.stringContaining("hooks/list") },
      });
    }).pipe(Effect.provide(platform)),
  );
  it.live("review audit: app-server log failure is visible once with its path", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([{ stderr: "first" }, { stderr: "second" }, complete()])),
      );
      yield* f.fs.makeDirectory(`${f.dataDir}/logs/app-server.log`, { recursive: true });
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const warnings = JSON.parse(result.stdout).digests[0].warnings.filter((value: string) =>
        value.includes("stderr log"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${f.dataDir}/logs/app-server.log`);
      expect(warnings[0]).toContain("permissions");
    }).pipe(Effect.provide(platform)),
  );
  it.live("review audit: doctor retains inaccessible hook paths", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const dir = `${f.repo}/.codex`;
      yield* f.fs.makeDirectory(dir);
      yield* f.fs.chmod(dir, 0);
      yield* Effect.addFinalizer(() => f.fs.chmod(dir, 0o700).pipe(Effect.orDie));
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const cwd = process.cwd();
          process.chdir(f.repo);
          return cwd;
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              runCli(["doctor", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
            );
            expect(result.status).toBe(0);
            expect(result.stderr).toBe("");
            expect(JSON.parse(result.stdout).repoHooks.detail).toContain(`${dir}/hooks.json`);
            expect(JSON.parse(result.stdout).repoHooks.detail).toContain("permissions");
          }),
        (cwd) => Effect.sync(() => process.chdir(cwd)),
      );
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["missing", "overflow"] as const)(
    "review audit: Git %s keeps its command and remedy",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario());
        yield* f.launch();
        if (mode === "missing") yield* f.fs.symlink("/missing/git", `${f.root}/git`);
        else
          yield* f.fs.writeFileString(
            `${f.root}/git`,
            '#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then printf "%01050000d" 0; exit 0; fi\nexec /usr/bin/git "$@"\n',
            { mode: 0o755 },
          );
        const contract = `${f.root}/contract.md`;
        yield* f.fs.writeFileString(contract, "work");
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = { cwd: process.cwd(), path: process.env.PATH };
            process.chdir(f.repo);
            process.env.PATH = f.root;
            return previous;
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.promise(() =>
                runCli(["start", "unit", "--new-worktree", "--contract", contract, "--json"], {
                  env: { ...f.env, LOG_LEVEL: "none" },
                }),
              );
              expect(result.status).toBe(9);
              expect(result.stdout).toBe("");
              expect(result.stderr).toContain("git");
              expect(result.stderr).toContain(mode === "missing" ? "Install" : "output exceeded");
              expect(result.stderr).toContain(mode === "missing" ? "NotFound" : "reduce");
            }),
          (previous) =>
            Effect.sync(() => {
              process.chdir(previous.cwd);
              if (previous.path === undefined) delete process.env.PATH;
              else process.env.PATH = previous.path;
            }),
        );
      }).pipe(Effect.provide(platform)),
  );
  it.live("review audit: dependency inspection permissions keep their path and category", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      const blocked = `${f.root}/private`;
      yield* f.fs.makeDirectory(`${blocked}/modules`, { recursive: true });
      yield* f.fs.writeFileString(`${f.worktree}/package.json`, "{}");
      yield* f.fs.symlink(`${blocked}/modules`, `${f.worktree}/node_modules`);
      yield* f.fs.chmod(blocked, 0);
      yield* Effect.addFinalizer(() => f.fs.chmod(blocked, 0o700).pipe(Effect.orDie));
      const file = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(file, "work");
      const result = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", file, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(6);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${f.worktree}/node_modules`);
      expect(result.stderr).toContain("permissions");
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["check-ignore", "show-ref", "merge-base"] as const)(
    "diagnostics: Git %s probe failures retain the command, output and remedy",
    (probe) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        yield* f.launch();
        if (probe !== "check-ignore") {
          yield* f.start({ worktree: f.repo, newWorktree: true });
          yield* f.wait();
          yield* f.git(`${f.repo}/.claude/worktrees/unit`, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "work",
          ]);
        }
        yield* f.fs.writeFileString(
          `${f.root}/git`,
          `#!/bin/sh\nif [ "$1" = "${probe}" ]; then printf PROBE_TAIL >&2; exit 42; fi\nexec /usr/bin/git "$@"\n`,
          { mode: 0o755 },
        );
        const contract = `${f.root}/contract.md`;
        yield* f.fs.writeFileString(contract, "work");
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = { cwd: process.cwd(), path: process.env.PATH };
            process.chdir(f.repo);
            process.env.PATH = `${f.root}:${previous.path ?? ""}`;
            return previous;
          }),
          () =>
            Effect.gen(function* () {
              const args =
                probe === "check-ignore"
                  ? ["start", "unit", "--new-worktree", "--contract", contract]
                  : ["archive", "unit"];
              const result = yield* Effect.promise(() =>
                runCli([...args, "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
              );
              expect(result.status).toBe(9);
              expect(result.stdout).toBe("");
              expect(result.stderr).toContain(`git ${probe}`);
              expect(result.stderr).toContain("exited 42");
              expect(result.stderr).toContain("PROBE_TAIL");
              expect(result.stderr).toContain("inspect the Git output");
            }),
          (previous) =>
            Effect.sync(() => {
              process.chdir(previous.cwd);
              if (previous.path === undefined) delete process.env.PATH;
              else process.env.PATH = previous.path;
            }),
        );
      }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: an unresolvable run entry does not hide the rest of the group", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.fs.makeDirectory(`${f.dataDir}/runs`, { recursive: true });
      const broken = `${f.dataDir}/runs/broken`;
      yield* f.fs.symlink(`${f.root}/missing`, broken);
      yield* f.launch();
      const result = yield* Effect.promise(() =>
        runCli(["status", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        skipped: [
          {
            path: broken,
            reason: expect.stringContaining("NotFound"),
            action: expect.stringContaining("inspect"),
          },
        ],
      });
    }).pipe(Effect.provide(platform)),
  );
  it.effect("diagnostics: a cancelled start identifies the run and retry action", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ method: Codex.Method.hooksList, respond: "none" }));
      yield* f.fs.makeDirectory(`${f.repo}/.codex`, { recursive: true });
      yield* f.fs.writeFileString(`${f.repo}/.codex/hooks.json`, "{}");
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const pending = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      ).pipe(Effect.forkChild);
      yield* f.awaitLog(Codex.Method.hooksList);
      const interrupt = yield* Effect.promise(() =>
        runCli(["interrupt", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(interrupt.status).toBe(0);
      const result = yield* Fiber.join(pending);
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("retry the start");
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: managed Git failure retains only its useful output tail", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.fs.writeFileString(
        `${f.repo}/.git/hooks/post-checkout`,
        "#!/bin/sh\nprintf START_MARKER >&2\nprintf '%05000d' 0 >&2\nprintf TAIL_MARKER >&2\nprintf 'HOOK_STDOUT token=LOCAL_TOOL_MESSAGE'\nexit 1\n",
        { mode: 0o755 },
      );
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(f.repo);
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              runCli(["start", "unit", "--new-worktree", "--contract", contract, "--json"], {
                env: { ...f.env, LOG_LEVEL: "none" },
              }),
            );
            expect(result.status).toBe(9);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain("git worktree add");
            expect(result.stderr).not.toContain("success(");
            expect(result.stderr).toContain(f.repo);
            expect(result.stderr).toContain("exited");
            expect(result.stderr).toContain("TAIL_MARKER");
            expect(result.stderr).toContain("HOOK_STDOUT token=LOCAL_TOOL_MESSAGE");
            expect(result.stderr).not.toContain("START_MARKER");
            expect(result.stderr).toContain("inspect the Git output");
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.live("diagnostics: excessive Git output names the command and remedy", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.fs.writeFileString(
        `${f.repo}/.git/hooks/post-checkout`,
        "#!/bin/sh\nprintf '%01050000d' 0 >&2\nprintf 'HOOK_TAIL'\nexit 1\n",
        { mode: 0o755 },
      );
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(f.repo);
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              runCli(["start", "unit", "--new-worktree", "--contract", contract, "--json"], {
                env: { ...f.env, LOG_LEVEL: "none" },
              }),
            );
            expect(result.status).toBe(9);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain("git worktree add");
            expect(result.stderr).not.toContain("success(");
            expect(result.stderr).toContain(f.repo);
            expect(result.stderr).toContain("reduce");
            expect(result.stderr).toContain("exited 1");
            expect(result.stderr).toContain("HOOK_TAIL");
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.live.each([
    { kind: "exit", setup: "printf setup-output >&2; exit 23", extra: [] },
    { kind: "timeout", setup: "exec sleep 10", extra: ["--budget", "1s"] },
  ])("diagnostics: setup $kind gives a safe next step", ({ setup, extra }) =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(f.repo);
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              runCli(
                [
                  "start",
                  "unit",
                  "--new-worktree",
                  "--contract",
                  contract,
                  "--setup",
                  setup,
                  ...extra,
                  "--json",
                ],
                {
                  env: { ...f.env, LOG_LEVEL: "none" },
                },
              ),
            );
            expect(result.status).toBe(9);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(setup);
            expect(result.stderr).toContain(`${f.repo}/.claude/worktrees/unit`);
            expect(result.stderr).toContain("inspect");
            expect(result.stderr).toContain("new run name");
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
    }).pipe(Effect.provide(platform)),
  );

  it.live("diagnostics: worktree inspection names the failed Git command", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* f.fs.writeFileString(`${f.worktree}/.git`, "invalid gitfile\n");
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(9);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("git --no-optional-locks status");
      expect(result.stderr).toContain(f.worktree);
      expect(result.stderr).toContain("exited");
      expect(result.stderr).toContain("fatal");
      expect(result.stderr).toContain("inspect the Git output");
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: managed starts outside Git explain where to run them", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(f.root);
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              runCli(["start", "unit", "--new-worktree", "--contract", contract, "--json"], {
                env: { ...f.env, LOG_LEVEL: "none" },
              }),
            );
            expect(result.status).toBe(9);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(f.root);
            expect(result.stderr).toContain("Run the command from a Git checkout");
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["failed", "malformed"] as const)(
    "diagnostics: %s Git checkout discovery names the command",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario());
        yield* f.launch();
        yield* f.fs.writeFileString(
          `${f.root}/git`,
          mode === "failed"
            ? "#!/bin/sh\nprintf 'DISCOVERY_TAIL' >&2\nexit 42\n"
            : "#!/bin/sh\nprintf 'unexpected output\\n'\n",
          { mode: 0o755 },
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = process.env.PATH;
            process.env.PATH = `${f.root}:${previous ?? ""}`;
            return previous;
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.promise(() =>
                runCli(["status", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
              );
              expect(result.status).toBe(9);
              expect(result.stdout).toBe("");
              expect(result.stderr).toContain("git worktree list");
              expect(result.stderr).toContain("permissions");
              if (mode === "failed") expect(result.stderr).toContain("DISCOVERY_TAIL");
              expect(JSON.parse(result.stderr).error.message).toBe(
                "The Git checkout or worktree could not be used.",
              );
            }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.PATH;
              else process.env.PATH = previous;
            }),
        );
      }).pipe(Effect.provide(platform)),
  );
  it.effect("diagnostics: worktree conflicts do not suggest interrupting an unconfirmed turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ method: Codex.Method.turnStart, respond: "none" }));
      yield* f.launch();
      yield* f.start().pipe(Effect.result, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.turnStart);
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const result = yield* Effect.promise(() =>
        runCli(["start", "other", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("forman wait unit");
      expect(result.stderr).not.toContain("interrupt");
      yield* TestClock.adjust("30 seconds");
      yield* f.untilState("unknown");
      const followup = yield* Effect.promise(() =>
        runCli(["followup", "unit", "continue", "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(followup.status).toBe(8);
      expect(followup.stdout).toBe("");
      expect(followup.stderr).toContain("forman wait unit");
      expect(followup.stderr).not.toContain("interrupt");
    }).pipe(Effect.provide(platform)),
  );
  it.effect(
    "diagnostics: a reserved worktree does not suggest waiting on an unregistered run",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario({ method: Codex.Method.hooksList, respond: "none" }));
        yield* f.fs.makeDirectory(`${f.repo}/.codex`, { recursive: true });
        yield* f.fs.writeFileString(`${f.repo}/.codex/hooks.json`, "{}");
        yield* f.launch();
        yield* f.start().pipe(Effect.result, Effect.forkChild);
        yield* f.awaitLog(Codex.Method.hooksList);
        const contract = `${f.root}/contract.md`;
        yield* f.fs.writeFileString(contract, "work");
        const result = yield* Effect.promise(() =>
          runCli(["start", "other", "--worktree", f.worktree, "--contract", contract, "--json"], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect(result.status).toBe(8);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("unit");
        expect(result.stderr).toContain("wait for the start to finish");
        expect(result.stderr).not.toContain("forman wait unit");
        expect(result.stderr).not.toContain("interrupt");
      }).pipe(Effect.provide(platform)),
  );
  it.live.each(["status", "wait"] as const)(
    "reports skipped run directories in %s group results",
    (command) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario());
        yield* f.fs.makeDirectory(f.runDir, { recursive: true });
        yield* f.fs.writeFileString(`${f.runDir}/run.json`, "secret=private invalid JSON");
        yield* f.launch();
        const args = command === "status" ? ["status"] : ["wait", "--all", "--timeout", "0ms"];
        for (const json of [false, true]) {
          const result = yield* Effect.promise(() =>
            runCli([...args, ...(json ? ["--json"] : [])], {
              env: { ...f.env, LOG_LEVEL: "none" },
            }),
          );
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(f.runDir);
          expect(result.stdout).toContain("inspect");
          expect(result.stdout).not.toContain("secret=private");
          if (json) {
            const decoded = Schema.decodeUnknownSync(D.DaemonResult)(JSON.parse(result.stdout));
            expect(decoded).toMatchObject({
              skipped: [
                {
                  path: f.runDir,
                  reason: expect.stringContaining("SchemaError"),
                  action: expect.stringContaining("inspect"),
                },
              ],
            });
          } else expect(result.stdout).toContain("skipped:");
        }
        yield* f.fs.remove(f.runDir, { recursive: true });
        const after = yield* Effect.promise(() =>
          runCli([...args, "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
        );
        expect(after.status).toBe(0);
        expect(after.stdout).not.toContain(f.runDir);
      }).pipe(Effect.provide(platform)),
  );
  it.effect("diagnostics: a Codex timeout names the run, method and recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ rules: [{ method: Codex.Method.threadStart, respond: "none" }] });
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const pending = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      ).pipe(Effect.forkChild);
      yield* f.awaitLog(Codex.Method.threadStart);
      yield* TestClock.adjust("180 seconds");
      const result = yield* Fiber.join(pending);
      expect(result.status).toBe(5);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain(Codex.Method.threadStart);
      expect(result.stderr).toContain("180000");
      expect(result.stderr).toContain("forman doctor");
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: inaccessible repo hook configuration names its path", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const hookDir = `${f.repo}/.codex`;
      yield* f.fs.makeDirectory(hookDir);
      yield* f.fs.writeFileString(`${hookDir}/hooks.json`, "{}");
      yield* f.fs.chmod(hookDir, 0);
      yield* Effect.addFinalizer(() => f.fs.chmod(hookDir, 0o700).pipe(Effect.orDie));
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const result = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(6);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${hookDir}/hooks.json`);
      expect(result.stderr).toContain("permissions");
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: daemon shutdown identifies active runs and how to stop them", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      yield* f.launch();
      yield* f.start();
      const result = yield* Effect.promise(() =>
        runCli(["daemon", "stop", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("Wait");
      expect(result.stderr).toContain("interrupt");
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: worktree preflight names each failed rule and its remedy", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.fs.makeDirectory(`${f.worktree}/nested`);
      yield* f.fs.writeFileString(`${f.worktree}/package.json`, "{}");
      const outside = `${f.root}/outside`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "outside", outside]);
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      yield* f.launch();
      for (const [worktree, remedy] of [
        [f.root, "Choose an accessible Git worktree root"],
        [`${f.worktree}/nested`, "Choose an accessible Git worktree root"],
        [f.repo, "Choose a linked worktree"],
        [outside, "Choose a linked worktree inside the main checkout"],
        [f.worktree, "install dependencies"],
      ] as const) {
        const result = yield* Effect.promise(() =>
          runCli(["start", "unit", "--worktree", worktree, "--contract", contract, "--json"], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect.soft(result.status).toBe(9);
        expect.soft(result.stdout).toBe("");
        expect.soft(result.stderr).toContain(worktree);
        expect.soft(result.stderr).toContain(remedy);
        if (worktree === f.root) expect(result.stderr).toContain("fatal: not a git repository");
      }
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: wait without a target explains the available targets", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      const result = yield* Effect.promise(() =>
        runCli(["wait", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("run name");
      expect(result.stderr).toContain("--all");
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: an invalid wait cursor identifies --after and how to resume", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      for (const json of [false, true]) {
        const result = yield* Effect.promise(() =>
          runCli(["wait", "unit", "--after", "not-a-cursor", ...(json ? ["--json"] : [])], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("--after");
        expect(result.stderr).toContain("cursor from a previous");
        if (json) Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
      }
    }).pipe(Effect.provide(platform)),
  );
  it.live("diagnostics: waiting followup names the question and valid actions", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([question(), { awaitResponse: "q" }])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      for (const json of [false, true]) {
        const result = yield* Effect.promise(() =>
          runCli(["followup", "unit", "continue", ...(json ? ["--json"] : [])], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect(result.status).toBe(8);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("answer or defer q1");
        expect(result.stderr).toContain("interrupt");
        expect(result.stderr).not.toContain("steer");
        if (json) Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
      }
    }).pipe(Effect.provide(platform)),
  );

  it.live("diagnostics: Codex launch failure names the executable and recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      f.env.CODEX_BIN = `${f.root}/missing-codex`;
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "PRIVATE_CONTRACT_CONTENT");
      for (const json of [false, true]) {
        const result = yield* Effect.promise(() =>
          runCli(
            [
              "start",
              "unit",
              "--worktree",
              f.worktree,
              "--contract",
              contract,
              ...(json ? ["--json"] : []),
            ],
            { env: { ...f.env, LOG_LEVEL: "none" } },
          ),
        );
        expect(result.status).toBe(5);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(f.env.CODEX_BIN);
        expect(result.stderr).toContain("Install Codex or set CODEX_BIN");
        expect(result.stderr).toContain("forman doctor");
        expect(result.stderr).not.toContain("PRIVATE_CONTRACT_CONTENT");
        if (json) Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
      }
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: each queued answer waits for its own delivered turn", () =>
    Effect.gen(function* () {
      const f = yield* queuedAnswersFixture();
      yield* f.launch();
      yield* f.handoff;
      yield* f.answer("A");
      const second = yield* f.answer("B");
      assert(second._tag === "Accepted");
      yield* f.release;
      yield* f.atTurn(3);
      yield* f.release;
      yield* f.atTurn(4);
      expect(yield* f.wait({ after: second.cursor, timeoutMs: 0 })).toMatchObject({
        outcome: "timeout",
        runs: [],
      });
      yield* f.release;
      expect(yield* f.wait({ after: second.cursor })).toMatchObject({
        runs: [{ kind: "done", digest: { turn: 4 } }],
      });
    }).pipe(Effect.provide(platform)),
  );

  it.effect("diagnostics: queued answers explain why archive must wait", () =>
    Effect.gen(function* () {
      const f = yield* queuedAnswersFixture();
      yield* f.launch();
      yield* f.handoff;
      yield* f.answer("A");
      const result = yield* Effect.promise(() =>
        runCli(["archive", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect.soft(result.stderr).toContain("unit");
      expect.soft(result.stderr).toContain("queued answers");
      expect.soft(result.stderr).toContain("wait");
      const followup = yield* Effect.promise(() =>
        runCli(["followup", "unit", "continue", "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(followup.status).toBe(8);
      expect(followup.stdout).toBe("");
      expect(followup.stderr).toContain("unit");
      expect(followup.stderr).toContain("queued");
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const reuse = yield* Effect.promise(() =>
        runCli(["start", "other", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(reuse.status).toBe(8);
      expect(reuse.stdout).toBe("");
      expect(reuse.stderr).toContain("unit");
      expect(reuse.stderr).toContain("queued answers");
      expect(reuse.stderr).toContain("cursor");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: a correction cannot overtake an older queued answer", () =>
    Effect.gen(function* () {
      const f = yield* queuedAnswersFixture();
      yield* f.launch();
      yield* f.handoff;
      yield* f.answer("A");
      yield* f.answer("B");
      yield* f.release;
      yield* f.atTurn(3);
      const third = yield* f.answer("C");
      expect(third).toMatchObject({ _tag: "Accepted", delivery: "queued" });
      assert(third._tag === "Accepted");
      yield* f.release;
      yield* f.atTurn(4);
      yield* f.release;
      expect(yield* f.wait({ after: third.cursor })).toMatchObject({
        runs: [{ kind: "done", digest: { turn: 5 } }],
      });
      const PrimaryInput = Schema.Struct({
        threadId: Schema.Literal("primary"),
        input: Schema.Array(Schema.Struct({ text: Schema.String })),
      });
      const inputs = (yield* f.readLog)
        .filter((entry) => entry.method === Codex.Method.turnStart)
        .map((entry) => entry.params)
        .filter(Schema.is(PrimaryInput))
        .map((entry) => entry.input[0]?.text);
      expect(inputs.slice(-3)).toEqual([
        expect.stringContaining(": A"),
        expect.stringContaining(": B"),
        expect.stringContaining(": C"),
      ]);
      expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
        text: "C",
        delivery: "followup",
      });
    }).pipe(Effect.provide(platform)),
  );

  it.effect(
    "review: shutdown honors accepted answers between handoff completion and start reservation",
    () =>
      Effect.gen(function* () {
        const f = yield* queuedAnswersFixture();
        const reached = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let armed = false;
        const observed = {
          ...f.fs,
          writeFileString: (
            file: string,
            text: string,
            options?: Parameters<typeof f.fs.writeFileString>[2],
          ) =>
            Effect.gen(function* () {
              if (
                armed &&
                file === `${f.runDir}/events.jsonl` &&
                text.includes('"to":"interrupted"')
              ) {
                armed = false;
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(released);
              }
              yield* f.fs.writeFileString(file, text, options);
            }),
        };
        const { supervisor, fiber } = yield* f
          .launch()
          .pipe(Effect.provideService(FileSystem.FileSystem, observed));
        // A failed assertion must also let an unexpectedly accepted Shutdown drain.
        yield* Effect.addFinalizer(() => TestClock.adjust(100));
        yield* Effect.gen(function* () {
          yield* f.handoff;
          yield* f.answer("A");
          armed = true;
          yield* f.release;
          yield* Deferred.await(reached);
          expect((yield* Store.readRun(f.runDir)).state).toBe("interrupted");
          const busy = yield* supervisor.busy;
          const shutdown = yield* f.request({ _tag: "Shutdown" }).pipe(Effect.result);
          expect(shutdown).toMatchObject({ _tag: "Failure", failure: { _tag: "RunConflict" } });
          expect(busy).toBe(true);
        }).pipe(Effect.ensuring(Deferred.succeed(released, undefined)));
        yield* f.atTurn(3);
        yield* f.release;
        yield* f.untilState("idle");
        expect(yield* f.request({ _tag: "Shutdown" })).toEqual({ _tag: "Ok" });
        // Orderly socket shutdown drains responses for 100 ms on the daemon clock.
        yield* TestClock.adjust(100);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(platform)),
  );

  it.effect("review: queued answers retain ownership for archive and worktree reuse", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      const daemon = yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* daemon.stop;
      const registry = yield* makeRegistry(f.dataDir);
      const run = yield* registry.lookup(name);
      const released = yield* Deferred.make<void>();
      yield* registry.enqueueAnswer(run, Deferred.await(released));
      yield* Effect.gen(function* () {
        expect(yield* registry.busy).toBe(true);
        const other = Schema.decodeUnknownSync(D.RunName)("other");
        for (const operation of [
          registry.archive(name, true),
          registry.reserveWorktree(name, f.worktree),
          registry.reserveWorktree(other, f.worktree),
        ])
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({ _tag: "RunConflict" });
        expect(yield* f.fs.exists(f.runDir)).toBe(true);
      }).pipe(Effect.ensuring(Deferred.succeed(released, undefined)));
      while (yield* registry.busy) yield* Effect.yieldNow;
      yield* registry.reserveWorktree(name, f.worktree);
      yield* registry.releaseWorktree(name, f.worktree);
      expect(yield* registry.archive(name, true)).toMatchObject({ _tag: "Archived" });
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["Answer", "Followup"] as const)(
    "deferred: %s races with another continuation and Shutdown without reversing locks",
    (first) =>
      Effect.gen(function* () {
        const script = scenario(
          turnRule([question(), { awaitResponse: "q" }, complete()]),
          turnRule([complete()]),
          { ...turnRule([complete()]), repeat: true },
          {
            method: Codex.Method.turnSteer,
            repeat: true,
            respond: { result: { turnId: "{{turn}}" } },
          },
        );
        const f = yield* fixture(script);
        const ready = `${f.root}/continuation-ready`;
        const release = `${f.root}/continuation-release`;
        yield* commandResult(ChildProcess.make("mkfifo", [release]));
        let turns = 0;
        yield* f.fs.writeFileString(
          f.scenarioFile,
          Schema.encodeSync(Schema.fromJsonString(Scenario))({
            rules: script.rules.map((rule) => {
              if (rule.method !== Codex.Method.turnStart || ++turns !== 2) return rule;
              return { ...rule, gate: { ready, release } };
            }),
          }),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("waiting");
        yield* f.cli(["defer", "unit", "q1"]);
        yield* f.untilState("idle");
        const answer: D.DaemonRequestBody = { _tag: "Answer", name, question: q1, text: "A" };
        const followup: D.DaemonRequestBody = { _tag: "Followup", name, message: "Continue" };
        const one = yield* f
          .request(first === "Answer" ? answer : followup)
          .pipe(Effect.result, Effect.forkChild);
        while (!(yield* f.fs.exists(ready))) yield* Effect.yieldNow;
        const two = yield* f
          .request(first === "Answer" ? followup : answer)
          .pipe(Effect.result, Effect.forkChild);
        expect(yield* f.request({ _tag: "Shutdown" }).pipe(Effect.flip)).toMatchObject({
          _tag: "RunConflict",
        });
        yield* f.fs.writeFileString(release, "go");
        expect((yield* Fiber.join(one))._tag).toBe("Success");
        const other = yield* Fiber.join(two);
        if (other._tag === "Failure") expect(other.failure).toMatchObject({ _tag: "RunConflict" });
        else expect(other.success._tag).toBe("Accepted");
        expect(yield* f.request({ _tag: "Ping" })).toMatchObject({ _tag: "Pong" });
      }).pipe(Effect.provide(platform)),
  );

  it.live("deferred: an idle late answer with --wait ignores another run's completion", () =>
    Effect.gen(function* () {
      const script = scenario(
        turnRule([question(), { awaitResponse: "q" }, complete()]),
        {
          ...turnRule(),
          respond: {
            result: { turn: { id: "peer-turn", status: "inProgress", error: null, items: [] } },
          },
        },
        {
          ...turnRule([
            notify(Codex.Method.turnCompleted, {
              threadId: "peer",
              turn: { id: "peer-turn", status: "completed", error: null, items: [] },
            }),
            notify(Codex.Method.turnCompleted, {
              threadId: "primary",
              turn: { id: "late", status: "completed", error: null, items: [] },
            }),
          ]),
          respond: {
            result: { turn: { id: "late", status: "inProgress", error: null, items: [] } },
          },
        },
      );
      const f = yield* fixture({
        rules: [
          {
            method: Codex.Method.threadStart,
            respond: { result: { ...opened, thread: { id: "primary" } } },
          },
          {
            method: Codex.Method.threadStart,
            respond: { result: { ...opened, thread: { id: "peer" } } },
          },
          ...script.rules,
        ],
      });
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      yield* f.cli(["defer", "unit", "q1"]);
      yield* f.untilState("idle");
      const other = `${f.repo}/work/peer`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "peer", other]);
      yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("peer"), worktree: other });
      const output = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
        yield* f.cli(["answer", "unit", "q1", "Approved", "--wait", "--timeout", "2s", "--json"]),
      );
      expect(output).toMatchObject({
        _tag: "Waited",
        runs: [{ name, kind: "done", digest: { turn: 2 } }],
      });
      assert(output._tag === "Waited");
      expect(output.runs).toHaveLength(1);
      expect(output.next).toContain("wait unit --after");
    }).pipe(Effect.provide(platform)),
  );
  it.effect("deferred: timeout releases the RPC without handing over the decision", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([question(), { awaitResponse: "q" }])));
      yield* f.launch();
      yield* f.start({ questionTimeoutMs: 1000 });
      yield* f.untilState("waiting");
      yield* TestClock.adjust(1000);
      yield* f.untilState("running");
      expect(yield* f.readLog).toContainEqual({
        result: {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: expect.stringContaining("No answer yet; the decision may need a person"),
            },
          ],
        },
      });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked", id: q1 },
        { _tag: "Deferred", id: q1, by: "timeout" },
      ]);
      expect(yield* f.status()).toMatchObject({
        questions: [],
        unansweredQuestions: [{ id: q1, question: "Which path?" }],
      });
      expect(yield* f.cli(["status", "unit"])).toContain("q1 deferred, unanswered");
    }).pipe(Effect.provide(platform)),
  );

  it.live("deferred: defer releases a question immediately with an optional note", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([question(), { awaitResponse: "q" }])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      expect(yield* f.cli(["defer", "unit", "q1", "Waiting for a person"])).toContain("ok");
      expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
        _tag: "Deferred",
        by: "orchestrator",
        note: "Waiting for a person",
      });
      expect(yield* f.readLog).toContainEqual({
        result: {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: expect.stringContaining("Orchestrator note: Waiting for a person"),
            },
          ],
        },
      });
      expect(
        yield* f.request({ _tag: "Defer", name, question: q1 }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining("deferred"),
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["steer", "followup"] as const)(
    "deferred: late answer uses %s with the original question context",
    (delivery) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([
              question(),
              { awaitResponse: "q" },
              ...(delivery === "followup" ? [complete()] : []),
            ]),
            { method: Codex.Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } },
            turnRule([complete()]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("waiting");
        yield* f.cli(["defer", "unit", "q1"]);
        yield* f.untilState(delivery === "followup" ? "idle" : "running");
        yield* f.cli(["answer", "unit", "q1", "Use A"]);
        const request = (yield* f.readLog)
          .filter(
            (entry) =>
              entry.method ===
              (delivery === "steer" ? Codex.Method.turnSteer : Codex.Method.turnStart),
          )
          .at(-1);
        expect(request?.params).toMatchObject({
          input: [
            { type: "text", text: 'Answer to your earlier question q1 ("Which path?"): Use A' },
          ],
        });
        expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
          _tag: "Resolved",
          resolution: "late",
          delivery,
          text: "Use A",
        });
        expect((yield* f.status()).unansweredQuestions ?? []).toEqual([]);
      }).pipe(Effect.provide(platform)),
  );

  it.live("deferred: a refused late steer falls back to a follow-up in the same command", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            question(),
            { awaitResponse: "q" },
            { awaitRequest: Codex.Method.turnSteer },
            complete(),
          ]),
          {
            method: Codex.Method.turnSteer,
            respond: { error: { code: -1, message: "activeTurnNotSteerable" } },
          },
          turnRule([complete()]),
        ),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      yield* f.cli(["defer", "unit", "q1"]);
      yield* f.untilState("running");
      expect(
        yield* f.cli(["answer", "unit", "q1", "Use A", "--wait", "--timeout", "2s", "--json"]),
      ).toContain('"kind":"done"');
      expect(
        (yield* f.readLog).filter((entry) => entry.method === Codex.Method.turnStart),
      ).toHaveLength(2);
      expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
        resolution: "late",
        delivery: "followup",
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live("deferred: another pending question takes priority over a late answer", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question(), { awaitResponse: "q" }, question("second")])),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      yield* f.cli(["defer", "unit", "q1"]);
      while (!(yield* f.status()).questions.some((q) => q.id === "q2")) yield* Effect.yieldNow;
      expect(
        yield* f.request({ _tag: "Answer", name, question: q1, text: "A" }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "RunConflict",
        detail:
          'Cannot answer q1 in run unit while q2 is pending. Use forman answer unit q2 "<answer>"; it can include this change.',
      });
      const answer = yield* Effect.promise(() =>
        runCli(["answer", "unit", "q1", "A", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(answer.status).toBe(8);
      expect(answer.stdout).toBe("");
      expect.soft(answer.stderr).toContain("unit");
      expect.soft(answer.stderr).toContain("q1");
      expect.soft(answer.stderr).toContain("forman answer unit q2");
      const steer = yield* Effect.promise(() =>
        runCli(["steer", "unit", "change", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(steer.status).toBe(8);
      expect(steer.stdout).toBe("");
      expect.soft(steer.stderr).toContain("unit");
      expect.soft(steer.stderr).toContain("forman answer unit q2");
      expect(
        yield* f.request({ _tag: "Defer", name, question: q1 }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "RunConflict",
        detail:
          "q1 in run unit is deferred; only a pending question can be deferred. Run forman status unit to see its questions.",
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live("deferred: a closed question conflicts without opening an app server", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question(), { awaitResponse: "q" }, complete()])),
      );
      const first = yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      yield* f.cli(["answer", "unit", "q1", "A"]);
      yield* f.untilState("idle");
      yield* first.stop;
      f.env.CODEX_BIN = `${f.root}/missing-codex`;
      yield* f.launch();
      const missing = yield* Effect.promise(() =>
        runCli(["defer", "unit", "q99", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(missing.status).toBe(7);
      expect(missing.stdout).toBe("");
      expect.soft(missing.stderr).toContain("unit");
      expect.soft(missing.stderr).toContain("q99");
      expect.soft(missing.stderr).toContain("forman status unit");
      expect(
        yield* f.request({ _tag: "Defer", name, question: q1 }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "RunConflict",
        detail:
          "q1 in run unit is answered; only a pending question can be deferred. Run forman status unit to see its questions.",
      });
      const closed = yield* Effect.promise(() =>
        runCli(["defer", "unit", "q1", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(closed.status).toBe(8);
      expect(closed.stdout).toBe("");
      expect.soft(closed.stderr).toContain("unit");
      expect.soft(closed.stderr).toContain("q1");
      expect.soft(closed.stderr).toContain("forman status unit");
    }).pipe(Effect.provide(platform)),
  );

  it.live("deferred: re-answering a resolved question sends a correction", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([question(), { awaitResponse: "q" }]), {
          method: Codex.Method.turnSteer,
          respond: { result: { turnId: "{{turn}}" } },
        }),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("waiting");
      yield* f.cli(["answer", "unit", "q1", "A"]);
      yield* f.cli(["answer", "unit", "q1", "Actually B"]);
      expect(
        (yield* f.readLog).find((entry) => entry.method === Codex.Method.turnSteer)?.params,
      ).toMatchObject({
        input: [
          { type: "text", text: 'Correction to your answer to q1 ("Which path?"): Actually B' },
        ],
      });
      expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
        resolution: "correction",
        delivery: "steer",
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["Steer", "Followup"] as const)(
    "deferred: %s supersedes unanswered questions",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([
              question(),
              { awaitResponse: "q" },
              ...(action === "Followup" ? [complete()] : []),
            ]),
            {
              method: Codex.Method.turnSteer,
              respond: { result: { turnId: "{{turn}}" } },
              steps: [complete()],
            },
            turnRule([complete()]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("waiting");
        yield* f.cli(["defer", "unit", "q1"]);
        yield* f.untilState(action === "Followup" ? "idle" : "running");
        yield* f.request({ _tag: action, name, message: "Continue without the decision" });
        yield* f.untilState("idle");
        expect((yield* f.status()).unansweredQuestions ?? []).toEqual([]);
        expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
          resolution: "superseded",
        });
        expect((yield* f.wait()).runs.at(-1)?.summary).not.toContain("unanswered");
      }).pipe(Effect.provide(platform)),
  );

  it.live.each(["blocked", "question"] as const)(
    "deferred: completion keeps %s questions visible and suggests answering",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([
              question("q", { question: "Choose?", kind }),
              { awaitResponse: "q" },
              complete(),
            ]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("waiting");
        const asked = yield* f.cli(["wait", "unit", "--timeout", "0ms"]);
        expect(asked).toContain('forman answer unit q1 "<answer>"');
        expect(asked).toContain("or: ");
        expect(asked).toContain("forman defer unit q1");
        yield* f.cli(["defer", "unit", "q1"]);
        yield* f.untilState("idle");
        const done = yield* f.cli(["wait", "unit", "--timeout", "0ms"]);
        expect(done).toContain(
          kind === "blocked" ? "blocked on q1" : "done, 1 unanswered question",
        );
        expect(done).toContain('forman answer unit q1 "<answer>"');
      }).pipe(Effect.provide(platform)),
  );

  it.effect.each([false, true])(
    "deferred: an answer during budget hand-off queues a follow-up after completion, wait=%s",
    (waiting) =>
      Effect.gen(function* () {
        // Fixed identities let another Start release the hand-off without a timer.
        const script = scenario(
          {
            ...turnRule([question(), { awaitResponse: "q" }]),
            respond: {
              result: { turn: { id: "work", status: "inProgress", error: null, items: [] } },
            },
          },
          {
            ...turnRule([
              { awaitRequest: Codex.Method.threadStart },
              notify(Codex.Method.turnCompleted, {
                threadId: "primary",
                turn: { id: "handoff", status: "completed", error: null, items: [] },
              }),
            ]),
            respond: {
              result: { turn: { id: "handoff", status: "inProgress", error: null, items: [] } },
            },
          },
          {
            method: Codex.Method.turnStart,
            when: { threadId: "primary" },
            respond: {
              result: { turn: { id: "delivered", status: "inProgress", error: null, items: [] } },
            },
            steps: [
              notify(Codex.Method.turnCompleted, {
                threadId: "primary",
                turn: { id: "delivered", status: "completed", error: null, items: [] },
              }),
            ],
          },
          turnRule([complete()]),
          {
            method: Codex.Method.turnInterrupt,
            respond: { result: {} },
            steps: [
              notify(Codex.Method.turnCompleted, {
                threadId: "primary",
                turn: { id: "work", status: "interrupted", error: null, items: [] },
              }),
            ],
          },
        );
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "primary" } } },
            },
            ...script.rules,
          ],
        });
        yield* f.launch();
        yield* f.start({ budgetMs: 1000 });
        yield* f.untilState("waiting");
        yield* f.cli(["defer", "unit", "q1"]);
        yield* TestClock.adjust(1000);
        while ((yield* f.status()).turnKind !== "handoff") yield* Effect.yieldNow;
        const pending = yield* f
          .cli([
            "answer",
            "unit",
            "q1",
            "A",
            "--json",
            ...(waiting ? ["--wait", "--timeout", "2s"] : []),
          ])
          .pipe(Effect.forkChild);
        while (
          !(yield* Store.readQuestions(f.runDir)).some(
            (line) => line._tag === "Resolved" && line.delivery === "queued",
          )
        )
          yield* Effect.yieldNow;
        if (!waiting) {
          const accepted = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
            yield* Fiber.join(pending),
          );
          expect(accepted).toMatchObject({ _tag: "Accepted", delivery: "queued" });
          assert(accepted._tag === "Accepted");
          const position: unknown = JSON.parse(
            atob(accepted.cursor.slice(3).replaceAll("-", "+").replaceAll("_", "/")),
          );
          expect(position).toMatchObject({
            positions: { unit: { continuation: expect.any(String) } },
          });
        }
        expect(
          (yield* f.readLog).filter((entry) => entry.method === Codex.Method.turnStart),
        ).toHaveLength(2);
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree: other });
        while ((yield* f.status()).turn < 3) yield* Effect.yieldNow;
        yield* f.untilState("idle");
        if (waiting)
          expect(JSON.parse(yield* Fiber.join(pending))).toMatchObject({
            _tag: "Waited",
            runs: [{ kind: "done", digest: { turn: 3, turnKind: "followup" } }],
          });
        expect((yield* Store.readQuestions(f.runDir)).at(-1)).toMatchObject({
          resolution: "late",
          delivery: "followup",
        });
      }).pipe(Effect.provide(platform)),
  );
  it.live.each(["start", "followup", "steer", "answer"] as const)(
    "%s --wait ignores a peer's completion and keeps a named next command",
    (command) =>
      Effect.gen(function* () {
        const primaryTurn = "primary-turn";
        const peerDone = notify(Codex.Method.turnCompleted, {
          threadId: "peer",
          turn: { id: "peer-turn", status: "completed", error: null, items: [] },
        });
        const initialSteps: Record<typeof command, Step[]> = {
          start: [],
          followup: [complete()],
          answer: [question(), { awaitResponse: "q" }, peerDone],
          steer: [],
        };
        const first = {
          ...turnRule(initialSteps[command]),
          respond: {
            result: { turn: { id: primaryTurn, status: "inProgress", error: null, items: [] } },
          },
        };
        const script = scenario();
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: {
                result: { ...opened, thread: { id: command === "start" ? "peer" : "primary" } },
              },
            },
            {
              method: Codex.Method.threadStart,
              respond: {
                result: { ...opened, thread: { id: command === "start" ? "primary" : "peer" } },
              },
            },
            ...script.rules,
            ...(command === "start" ? [] : [first]),
            {
              ...turnRule(),
              respond: {
                result: { turn: { id: "peer-turn", status: "inProgress", error: null, items: [] } },
              },
            },
            turnRule([peerDone]),
            {
              method: Codex.Method.turnSteer,
              respond: { result: { turnId: primaryTurn } },
              steps: [peerDone],
            },
          ],
        });
        const other = `${f.repo}/work/peer`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "peer", other]);
        yield* f.launch();
        if (command !== "start") {
          yield* f.start();
          const initialState: Record<typeof command, D.RunState> = {
            followup: "idle",
            answer: "waiting",
            steer: "running",
          };
          yield* f.untilState(initialState[command]);
        }
        yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("peer"), worktree: other });
        const contract = `${f.root}/contract.md`;
        yield* f.fs.writeFileString(contract, "Do work");
        const argumentsByCommand = {
          start: ["--worktree", f.worktree, "--contract", contract],
          answer: ["q1", "Proceed"],
          followup: ["Proceed"],
          steer: ["Proceed"],
        };
        const output = yield* f.cli([
          command,
          "unit",
          ...argumentsByCommand[command],
          "--wait",
          "--timeout",
          "100ms",
          "--json",
        ]);
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(output),
        ).toMatchObject({
          outcome: "timeout",
          runs: [],
          next: expect.stringContaining(" wait unit --after "),
        });
      }).pipe(Effect.provide(platform)),
  );

  it.live(
    "events hides protocol chatter by default and preserves verbose and JSON pagination",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([
              notify("turn/moderationMetadata", { threadId: "{{thread}}" }),
              notify("turn/diff/updated", { threadId: "{{thread}}" }),
              notify(Codex.Method.itemCompleted, {
                threadId: "{{thread}}",
                turnId: "{{turn}}",
                item: message("Working"),
              }),
              complete(),
            ]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("idle");
        const human = yield* f.cli(["events", "unit"]);
        expect(human).toContain("AgentMessage Working");
        expect(human).toContain("TurnStarted");
        expect(human).toContain("TurnCompleted");
        expect(human).toContain("StateChanged");
        expect(human).not.toContain("Other");
        const full = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
          yield* f.cli(["events", "unit", "--json"]),
        );
        assert(full._tag === "Events");
        expect(full.events.filter(({ event }) => event._tag === "Other")).toHaveLength(2);
        expect(human).toContain(`--after ${full.next}`);
        const verbose = yield* f.cli(["events", "unit", "--verbose"]);
        expect(verbose).toContain("Other turn/moderationMetadata");
        expect(verbose).toContain("Other turn/diff/updated");
        expect(verbose.trimEnd().split("\n").at(-1)).toContain(`--after ${full.next} --verbose`);
        const chatter = yield* f.cli(["events", "unit", "--after", "2", "--limit", "2"]);
        expect(chatter).not.toContain("Other");
        expect(chatter).toContain("--after 4");
      }).pipe(Effect.provide(platform)),
  );

  it.live("socket interrupt cancels a start during setup before looking up its run", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      const pending = yield* f
        .start({
          worktree: f.repo,
          newWorktree: true,
          setup: `printf ready > ${f.root}/setup-ready; exec tail -f /dev/null`,
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!(yield* f.fs.exists(`${f.root}/setup-ready`))) yield* Effect.yieldNow;
      expect(yield* f.request({ _tag: "Interrupt", name })).toEqual({ _tag: "Ok" });
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RunConflict" },
      });
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
      expect(yield* f.request({ _tag: "Shutdown" })).toEqual({ _tag: "Ok" });
    }).pipe(Effect.provide(platform)),
  );
  it.effect("review: cancellation during identity collection retains the rollback receipt", () =>
    Effect.gen(function* () {
      const f = yield* preflightFixture();
      yield* commandResult(ChildProcess.make("mkfifo", [`${f.root}/identity-release`]));
      const realGit = (yield* commandResult(ChildProcess.make("which", ["git"]))).stdout.trim();
      yield* f.fs.writeFileString(
        `${f.root}/git`,
        `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --absolute-git-dir ] && [ ! -f '${f.root}/identity-ready' ]; then
  printf ready > '${f.root}/identity-ready'
  cat '${f.root}/identity-release' > /dev/null
fi
exec '${realGit}' "$@"
`,
        { mode: 0o755 },
      );
      const previous = process.env.PATH;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.PATH = `${f.root}:${previous ?? ""}`;
        }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.PATH;
            else process.env.PATH = previous;
          }),
      );
      const pending = yield* f.turns
        .start(f.body, Effect.void)
        .pipe(Effect.result, Effect.forkChild);
      while (!(yield* f.fs.exists(`${f.root}/identity-ready`))) yield* Effect.yieldNow;
      const cancelled = yield* f.turns.cancelStart(name).pipe(Effect.forkChild);
      yield* TestClock.adjust(0);
      yield* f.fs.writeFileString(`${f.root}/identity-release`, "go\n");
      expect(yield* Fiber.join(cancelled)).toBe(true);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
      expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toBe("");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("review: cancellation does not acknowledge a Start rejected before preflight", () =>
    Effect.gen(function* () {
      const f = yield* preflightFixture();
      const body = { ...f.body, newWorktree: false, worktree: f.worktree };
      yield* f.turns.start(body, Effect.void);
      yield* f.registry.starts.take(1);
      const pending = yield* f.turns.start(body, Effect.void).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust(0);
      const cancelled = yield* f.turns.cancelStart(name).pipe(Effect.forkChild);
      yield* TestClock.adjust(0);
      yield* f.registry.starts.release(1);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(yield* Fiber.join(cancelled)).toBe(false);
      expect(f.registry.runs.get(name)?.record.state).toBe("running");
    }).pipe(Effect.provide(platform)),
  );

  it.live("failed setup retains dirty work and reports both the exit and retained path", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.launch();
      const error = yield* f
        .start({
          worktree: f.repo,
          newWorktree: true,
          setup: "printf keep > result.txt; exit 23",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        detail: expect.stringMatching(/exited 23[\s\S]*Rollback retained/),
      });
      expect(yield* f.fs.readFileString(`${f.repo}/.claude/worktrees/unit/result.txt`)).toBe(
        "keep",
      );
      expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toContain(
        "forman/unit",
      );
      expect(yield* f.request({ _tag: "Shutdown" })).toMatchObject({ _tag: "Ok" });
    }).pipe(Effect.provide(platform)),
  );

  it.live("preflight cancellation joins setup and releases ownership before acknowledging", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      const config = yield* Effect.service(AppConfig).pipe(Effect.provide(AppConfig.layer(f.env)));
      const registry = yield* makeRegistry(f.dataDir);
      const servers = yield* makeAppServer(
        config,
        "test",
        registry,
        () => Effect.void,
        () => Effect.void,
      );
      const turns = yield* makeTurns(registry, servers, config);
      const body = {
        _tag: "Start" as const,
        name,
        worktree: f.repo,
        newWorktree: true,
        contract: "Do the work",
        write: false,
        skipDepsCheck: false,
      };
      const pending = yield* turns
        .start(
          {
            ...body,
            setup: `trap 'exit 0' TERM; /bin/sh -c 'trap "printf stopped > ${f.root}/stopped; exit 0" TERM; printf ready > ${f.root}/ready; while :; do :; done' & wait`,
          },
          Effect.void,
        )
        .pipe(Effect.result, Effect.forkChild);
      while (!(yield* f.fs.exists(`${f.root}/ready`))) yield* Effect.yieldNow;
      expect(yield* turns.cancelStart(name)).toBe(true);
      expect(yield* f.fs.readFileString(`${f.root}/stopped`)).toBe("stopped");
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RunConflict", detail: expect.stringContaining("cancelled") },
      });
      expect(yield* turns.cancelStart(name)).toBe(false);
      expect(yield* turns.start(body, Effect.void)).toMatchObject({ _tag: "Started" });
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["setup", "from"] as const)(
    "socket Start refuses %s without managed mode before touching the repository",
    (option) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario());
        yield* f.launch();
        const exclude = yield* f.fs.readFileString(`${f.repo}/.git/info/exclude`);
        const result = yield* f
          .start({
            worktree: f.repo,
            ...(option === "setup" ? { setup: "touch marker" } : { from: "HEAD" }),
          })
          .pipe(Effect.result);
        expect(yield* f.fs.exists(`${f.repo}/marker`)).toBe(false);
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Usage" } });
        expect(yield* f.fs.readFileString(`${f.repo}/.git/info/exclude`)).toBe(exclude);
        expect(yield* f.fs.exists(f.runDir)).toBe(false);
        expect(yield* f.readLog).toEqual([]);
        expect(yield* f.request({ _tag: "Shutdown" })).toMatchObject({ _tag: "Ok" });
      }).pipe(Effect.provide(platform)),
  );

  it.effect.each([undefined, 1000])(
    "setup deadline %s joins its process group, rolls back and releases the reservation",
    (budgetMs) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        yield* f.launch();
        const pending = yield* f
          .start({
            worktree: f.repo,
            newWorktree: true,
            ...(budgetMs === undefined ? {} : { budgetMs }),
            setup: `trap 'exit 0' TERM; /bin/sh -c 'trap "printf stopped > ${f.root}/stopped; exit 0" TERM; printf ready > ${f.root}/ready; while :; do :; done' & wait`,
          })
          .pipe(Effect.result, Effect.forkChild);
        while (!(yield* f.fs.exists(`${f.root}/ready`))) yield* Effect.yieldNow;
        yield* TestClock.adjust(budgetMs ?? 600_000);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "WorktreeInvalid", detail: expect.stringContaining("timed out") },
        });
        expect(yield* f.fs.readFileString(`${f.root}/stopped`)).toBe("stopped");
        expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
        expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toBe("");
        expect(yield* f.readLog).toEqual([]);
        expect(yield* f.start({ worktree: f.repo, newWorktree: true })).toMatchObject({
          _tag: "Started",
        });
        yield* f.wait();
      }).pipe(Effect.provide(platform)),
  );

  it.live("release B1: refuses a skipped name and preserves all of its history", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.fs.makeDirectory(f.runDir, { recursive: true });
      yield* f.fs.writeFileString(`${f.runDir}/run.json`, "unreadable record");
      yield* f.fs.writeFileString(`${f.runDir}/last-message.md`, "irreplaceable work");
      yield* f.launch();
      expect((yield* f.start().pipe(Effect.result))._tag).toBe("Failure");
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const start = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(start.status).toBe(8);
      expect(start.stdout).toBe("");
      expect(start.stderr).toContain(f.runDir);
      expect(start.stderr).toContain("inspect");
      for (const json of [false, true]) {
        const result = yield* Effect.promise(() =>
          runCli(["status", "unit", ...(json ? ["--json"] : [])], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect(result.status).toBe(8);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("unit");
        expect(result.stderr).toContain(f.runDir);
        expect(result.stderr).toContain("inspect");
        if (json)
          expect(JSON.parse(result.stderr).error.message).toBe(
            "The request could not be completed.",
          );
        expect(result.stderr).not.toContain("unreadable record");
      }
      expect(yield* f.fs.readFileString(`${f.runDir}/run.json`)).toBe("unreadable record");
      expect(yield* f.fs.readFileString(`${f.runDir}/last-message.md`)).toBe("irreplaceable work");
    }).pipe(Effect.provide(platform)),
  );

  it.live("release B2: Unicode named, group and accepted cursors round-trip without replay", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([complete()]), { ...turnRule(), repeat: true }),
        false,
        "项目-東京",
      );
      yield* f.launch();
      yield* f.start();
      const first = yield* f.wait();
      expect(first.runs).toMatchObject([{ kind: "done" }]);
      expect((yield* f.wait({ after: first.cursor, timeoutMs: 0 })).outcome).toBe("timeout");
      const other = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree: other });
      const accepted = yield* f.request({ _tag: "Followup", name, message: "Continue" });
      assert(accepted._tag === "Accepted");
      expect(accepted.all).toBeUndefined();
      expect((yield* f.wait({ after: accepted.cursor, timeoutMs: 0 })).outcome).toBe("timeout");
    }).pipe(Effect.provide(platform)),
  );

  it.live("release O3: group waits preserve git discovery failures", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      yield* f.launch();
      yield* f.start();
      yield* f.fs.writeFileString(`${f.repo}/.git/config`, "[broken");
      expect(
        yield* f.wait({ names: [], all: true, cwd: f.repo, timeoutMs: 0 }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "WorktreeInvalid" });
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "release O7: diagnostic capture retains useful output and redacts token-shaped secrets",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(
          scenario(
            turnRule([
              { stderr: "useful stderr sk-testPrivateSentinel" },
              notify(Codex.Method.itemCompleted, {
                threadId: "{{thread}}",
                turnId: "{{turn}}",
                item: {
                  type: "commandExecution",
                  id: "cmd",
                  command: "test",
                  status: "completed",
                  aggregatedOutput: "useful command output sk-testPrivateSentinel",
                  exitCode: 0,
                },
              }),
              complete(),
            ]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.wait();
        const stderr = `${f.dataDir}/logs/app-server.log`;
        while (!(yield* f.fs.exists(stderr))) yield* Effect.yieldNow;
        while (!(yield* f.fs.readFileString(stderr)).includes("useful stderr [redacted]\n"))
          yield* Effect.yieldNow;
        expect(yield* f.fs.readFileString(stderr)).toContain("useful stderr [redacted]");
        expect(yield* f.fs.readFileString(`${f.runDir}/events.jsonl`)).toContain(
          "useful command output [redacted]",
        );
        expect(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).toContain(
          "useful command output [redacted]",
        );
        for (const file of [stderr, `${f.runDir}/codex.jsonl`, `${f.runDir}/events.jsonl`])
          expect(yield* f.fs.readFileString(file)).not.toContain("sk-testPrivateSentinel");
      }).pipe(Effect.provide(platform)),
  );

  it.live("release B2: legacy Latin-1 cursors retain paths whose bytes also form valid UTF-8", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()), false, "Ã©");
      yield* f.launch();
      yield* f.start();
      const legacy = Schema.decodeUnknownSync(D.Cursor)(
        btoa(JSON.stringify({ _tag: "GroupCursor", group: f.repo, positions: {} })),
      );
      expect((yield* f.wait({ names: [], all: true, after: legacy, timeoutMs: 0 })).outcome).toBe(
        "timeout",
      );
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: stderr redacts private-key blocks across transport lines", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            { stderr: "before-private-key" },
            { stderr: "-----BEGIN RSA PRIVATE KEY-----" }, // pragma: allowlist secret -- synthetic fixture
            { stderr: "short-private-key-payload" },
            { stderr: "-----END RSA PRIVATE KEY-----" }, // pragma: allowlist secret -- synthetic fixture
            { stderr: "after-private-key" },
            complete(),
          ]),
        ),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.wait();
      const file = `${f.dataDir}/logs/app-server.log`;
      while (!(yield* f.fs.exists(file))) yield* Effect.yieldNow;
      while (!(yield* f.fs.readFileString(file)).includes("after-private-key\n"))
        yield* Effect.yieldNow;
      const text = yield* f.fs.readFileString(file);
      expect(text).toContain("before-private-key\n");
      expect(text).toContain("after-private-key\n");
      expect(text).toContain("[redacted private key]\n");
      expect(text).not.toContain("short-private-key-payload");
      expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(text).not.toContain("END RSA PRIVATE KEY");
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: concurrent retirement joins the first connection cleanup", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const registry = yield* makeRegistry(f.dataDir);
      const config = yield* AppConfig.pipe(Effect.provide(AppConfig.layer(f.env)));
      const servers = yield* makeAppServer(
        config,
        "test",
        registry,
        () => Effect.void,
        () => Effect.void,
      );
      const server = yield* servers.get;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(
        server.scope,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const first = yield* servers.retire(server).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const second = yield* servers
        .retire(server)
        .pipe(
          Effect.andThen(Deferred.succeed(completed, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      const premature = yield* Deferred.isDone(completed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(premature).toBe(false);
    }).pipe(Effect.provide(platform)),
  );

  it.live("review: journal reconciliation stops after finding its published transition", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      const first = yield* f.launch();
      yield* f.start();
      yield* f.wait();
      yield* first.stop;
      const id = crypto.randomUUID();
      yield* Store.appendEvent(f.runDir, { _tag: "StateChanged", from: "idle", to: "lost" }, id);
      yield* Store.writeRun(f.runDir, {
        ...(yield* Store.readRun(f.runDir)),
        state: "lost",
        pendingStateEvent: { id, from: "idle", to: "lost" },
      });
      yield* f.fs.writeFileString(`${f.runDir}/events.jsonl`, "unreadable later event\n", {
        flag: "a",
      });
      const registry = yield* makeRegistry(f.dataDir);
      expect((yield* registry.lookup(name)).record.pendingStateEvent).toBe(null);
    }).pipe(Effect.provide(platform)),
  );

  it.live("release B5: future formats refuse archive before managed-worktree cleanup", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start({ worktree: f.repo, newWorktree: true });
      yield* f.wait();
      const file = `${f.runDir}/run.json`;
      const stored = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(yield* f.fs.readFileString(file));
      const future = JSON.stringify({ ...stored, formatVersion: 3 });
      yield* f.fs.writeFileString(file, future);
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
      });
      for (const json of [false, true]) {
        const result = yield* Effect.promise(() =>
          runCli(["archive", "unit", ...(json ? ["--json"] : [])], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect(result.status).toBe(8);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("unit");
        expect(result.stderr).toContain(f.runDir);
        expect(result.stderr).toContain("inspect");
      }
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(true);
      expect(yield* f.fs.readFileString(file)).toBe(future);
    }).pipe(Effect.provide(platform)),
  );

  it.live("diagnostics: archive explains an active persisted run record", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* Store.writeRun(f.runDir, { ...(yield* Store.readRun(f.runDir)), state: "running" });
      const result = yield* Effect.promise(() =>
        runCli(["archive", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("running");
      expect(result.stderr).toContain("inspect");
      expect(result.stderr).toContain(f.runDir);
    }).pipe(Effect.provide(platform)),
  );

  it.live("release O5: exit reasons reach the lost digest and one connection log", () => {
    const records: LogEntry[] = [];
    const logger = Logger.make((input) =>
      records.push(
        entry({
          date: input.date,
          level: input.logLevel,
          message: input.message,
          annotations: input.fiber.getRef(References.CurrentLogAnnotations),
        }),
      ),
    );
    return Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), {
          method: Codex.Method.turnSteer,
          respond: { result: { turnId: "{{turn}}" } },
          steps: [{ exit: 17 }],
        }),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.request({ _tag: "Steer", name, message: "crash" });
      expect((yield* f.untilState("lost")).failure).toMatchObject({
        message: expect.stringContaining("app server exited with code 17"),
      });
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(f.worktree);
      expect(result.stdout).toContain("forman doctor");
      expect(records.filter(({ msg }) => msg === "supervisor.appServer.ended")).toMatchObject([
        { names: "unit", lossReason: "app server exited with code 17" },
      ]);
    }).pipe(Effect.provide(platform), Effect.provide(Logger.layer([logger])));
  });

  it.live("release O6: background persistence failures keep safe operation context", () => {
    const records: LogEntry[] = [];
    const logger = Logger.make((input) =>
      records.push(
        entry({
          date: input.date,
          level: input.logLevel,
          message: input.message,
          annotations: input.fiber.getRef(References.CurrentLogAnnotations),
        }),
      ),
    );
    return Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), {
          method: Codex.Method.turnSteer,
          respond: { result: { turnId: "{{turn}}" } },
          steps: [notify("probe", { threadId: "{{thread}}" })],
        }),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("running");
      yield* f.fs.remove(`${f.runDir}/codex.jsonl`, { force: true });
      yield* f.fs.makeDirectory(`${f.runDir}/codex.jsonl`);
      yield* f.request({ _tag: "Steer", name, message: "trigger" });
      yield* f.untilState("unknown");
      expect(records.filter(({ msg }) => msg === "supervisor.run.failed")).toMatchObject([
        {
          name: "unit",
          reasonTag: "PlatformError",
          method: expect.any(String),
          path: `${f.runDir}/codex.jsonl`,
          reason: expect.any(String),
        },
      ]);
      expect((yield* Store.readRun(f.runDir)).failure?.message).toContain("PlatformError");
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("unit");
      expect(result.stdout).toContain(`${f.runDir}/codex.jsonl`);
      expect(result.stdout).toContain("forman doctor");
    }).pipe(Effect.provide(platform), Effect.provide(Logger.layer([logger])));
  });

  it.live("release C5: a journal failure recovers a reserved follow-up", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()]), turnRule()));
      yield* f.launch();
      yield* f.start();
      yield* f.wait();
      const other = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree: other });
      const events = `${f.runDir}/events.jsonl`;
      yield* f.fs.rename(events, `${events}.saved`);
      yield* f.fs.makeDirectory(events);
      expect(
        (yield* f.request({ _tag: "Followup", name, message: "Continue" }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* f.fs.remove(events, { recursive: true });
      yield* f.fs.rename(`${events}.saved`, events);
      // The damaged journal prevents persisting recovery; public state still fails closed.
      expect((yield* f.status()).state).toBe("failed");
      expect(
        (yield* f.readLog).filter((message) => message.method === Codex.Method.turnStart),
      ).toHaveLength(2);
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "release C10: restart publishes a state outcome lost between run rename and event append",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        const live = yield* f.launch();
        yield* f.start();
        const completed = yield* f.wait();
        yield* live.stop;
        const registry = yield* makeRegistry(f.dataDir);
        const run = yield* registry.lookup(name);
        let current = run.record;
        let injected = false;
        Object.defineProperty(run, "record", {
          get: () => current,
          set: (next: D.RunRecord) => {
            current = next;
            if (next.state === "lost" && !injected) {
              injected = true;
              renameSync(`${f.runDir}/events.jsonl`, `${f.runDir}/events.saved`);
              mkdirSync(`${f.runDir}/events.jsonl`);
            }
          },
        });
        expect((yield* registry.state(run, "lost").pipe(Effect.result))._tag).toBe("Failure");
        yield* f.fs.remove(`${f.runDir}/events.jsonl`, { recursive: true });
        yield* f.fs.rename(`${f.runDir}/events.saved`, `${f.runDir}/events.jsonl`);
        yield* f.launch();
        const recovered = yield* f.wait({ after: completed.cursor, timeoutMs: 0 });
        expect(recovered.runs).toMatchObject([{ kind: "lost" }]);
      }).pipe(Effect.provide(platform)),
  );

  it.live.each(["state", "lost"] as const)(
    "%s publication finishes its journal when interrupted after the run record changes",
    (operation) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        const daemon = yield* f.launch();
        yield* f.start();
        yield* f.wait();
        yield* daemon.stop;
        const registry = yield* makeRegistry(f.dataDir);
        const run = yield* registry.lookup(name);
        if (operation === "lost") {
          yield* registry.state(run, "waiting");
          yield* Store.appendQuestion(f.runDir, {
            _tag: "Asked",
            id: q1,
            turn: 1,
            kind: "blocked",
            question: "Choose?",
            at: run.record.updatedAt,
          });
        }
        let current = run.record;
        let interrupted = false;
        let publishing: Fiber.Fiber<void, unknown> | undefined;
        Object.defineProperty(run, "record", {
          get: () => current,
          set: (next: D.RunRecord) => {
            current = next;
            if (next.state === "lost" && next.pendingStateEvent && !interrupted) {
              interrupted = true;
              publishing?.interruptUnsafe();
            }
          },
        });
        publishing = yield* run.lock
          .withPermits(1)(operation === "lost" ? registry.lost(run) : registry.state(run, "lost"))
          .pipe(Effect.forkChild);
        yield* Fiber.await(publishing);
        expect(interrupted).toBe(true);
        expect((yield* Store.readEvents(f.runDir)).events.at(-1)?.event).toEqual({
          _tag: "StateChanged",
          from: operation === "lost" ? "waiting" : "idle",
          to: "lost",
        });
        expect((yield* Store.readRun(f.runDir)).pendingStateEvent).toBe(null);
        expect(run.record.pendingStateEvent).toBe(null);
      }).pipe(Effect.provide(platform)),
  );

  it.effect(
    "release C3: unknown expiry retires Codex before another run can own the worktree",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario({ method: Codex.Method.turnStart, respond: "none" }));
        const pidFile = `${f.root}/app.pid`;
        const wrapper = `${f.root}/tracked-codex`;
        yield* f.fs.writeFileString(
          wrapper,
          `#!/bin/sh\nif [ "$1" = app-server ] && [ "$2" = --listen ]; then\n  echo $$ > '${pidFile}'\nfi\nexec '${process.execPath}' '${fake}' "$@"\n`,
          { mode: 0o755 },
        );
        f.env.CODEX_BIN = wrapper;
        yield* f.launch();
        const pending = yield* f.start().pipe(Effect.result, Effect.forkChild);
        yield* f.awaitLog(Codex.Method.turnStart);
        const pid = Number((yield* f.fs.readFileString(pidFile)).trim());
        yield* TestClock.adjust("30 seconds");
        expect((yield* Fiber.join(pending))._tag).toBe("Failure");
        expect((yield* f.status()).state).toBe("unknown");
        yield* TestClock.adjust("5 minutes");
        yield* f.untilState("lost");
        expect(() => process.kill(pid, 0)).toThrow();
        yield* f.fs.writeFileString(
          f.scenarioFile,
          Schema.encodeSync(Schema.fromJsonString(Scenario))(scenario(turnRule([complete()]))),
        );
        expect(
          yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("replacement") }),
        ).toMatchObject({ _tag: "Started" });
        expect(
          (yield* f.wait({ names: [Schema.decodeUnknownSync(D.RunName)("replacement")] })).runs,
        ).toMatchObject([{ kind: "done" }]);
      }).pipe(Effect.provide(platform)),
  );

  it.live(
    "release C3: a turn reply followed by a failed state write retains worktree ownership",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario({ ...turnRule(), repeat: true }));
        const wrapper = `${f.root}/fault-after-turn-reply`;
        yield* f.fs.writeFileString(
          wrapper,
          `#!${process.execPath}
const fs = require("node:fs");
const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(fake)}, ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
let injected = false;
require("node:readline").createInterface({ input: child.stdout }).on("line", line => {
  const message = JSON.parse(line);
  if (!injected && message.result?.turn?.status === "inProgress") {
    injected = true;
    fs.mkdirSync(${JSON.stringify(`${f.runDir}/run.json.tmp`)});
  }
  process.stdout.write(line + "\\n");
});
child.on("exit", code => process.exit(code ?? 1));
`,
          { mode: 0o755 },
        );
        f.env.CODEX_BIN = wrapper;
        yield* f.launch();
        expect((yield* f.start().pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* f.status()).state).toBe("unknown");
        expect(
          yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("other") }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining("unknown") });
        yield* f.fs.remove(`${f.runDir}/run.json.tmp`, { recursive: true });
      }).pipe(Effect.provide(platform)),
  );

  it.live("archive preserves unmerged commits when the source branch has been deleted", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.git(f.repo, ["branch", "source"]);
      yield* f.launch();
      yield* f.start({ worktree: f.repo, newWorktree: true, from: "source" });
      yield* f.wait();
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      yield* f.git(worktree, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "work",
      ]);
      yield* f.git(f.repo, ["branch", "-D", "source"]);
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining("unmerged commits"),
      });
      expect(yield* f.fs.exists(worktree)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: a managed child can start from an active parent's checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ ...turnRule(), repeat: true }));
      yield* f.launch();
      yield* f.start({ worktree: f.repo, newWorktree: true });
      expect(
        yield* f.start({
          name: Schema.decodeUnknownSync(D.RunName)("child"),
          worktree: `${f.repo}/.claude/worktrees/unit`,
          newWorktree: true,
        }),
      ).toMatchObject({ _tag: "Started", branch: "forman/child" });
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: archive preserves a managed worktree reserved by another active run", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()]), turnRule()));
      yield* f.launch();
      yield* f.start({ worktree: f.repo, newWorktree: true });
      yield* f.wait();
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree });
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining("other"),
      });
      expect(yield* f.fs.exists(worktree)).toBe(true);
      yield* f.request({ _tag: "Archive", name, keepWorktree: true });
      expect(yield* f.fs.exists(worktree)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: setup reserves its new path against a differently named start", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ ...turnRule(), repeat: true }));
      yield* f.launch();
      yield* commandResult(ChildProcess.make("mkfifo", [`${f.root}/release`]));
      const first = yield* f
        .start({
          worktree: f.repo,
          newWorktree: true,
          setup: `printf ready > '${f.root}/ready'; cat '${f.root}/release'`,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.raceFirst(
        Effect.gen(function* () {
          while (!(yield* f.fs.exists(`${f.root}/ready`))) yield* Effect.yieldNow;
        }),
        Fiber.join(first).pipe(
          Effect.flatMap((result) =>
            Effect.sync(() =>
              assert.fail(`Setup ended before readiness: ${JSON.stringify(result)}`),
            ),
          ),
        ),
      );
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      expect(yield* f.request({ _tag: "Shutdown" }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining("unit"),
      });
      const second = yield* f
        .start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree })
        .pipe(Effect.result);
      if (second._tag === "Success")
        yield* f.fs.writeFileString(`${worktree}/result.txt`, "other run's work");
      yield* f.fs.writeFileString(`${f.root}/release`, "go\n");
      const initial = yield* Fiber.join(first);
      expect(second).toMatchObject({ _tag: "Failure", failure: { _tag: "RunConflict" } });
      expect(initial._tag).toBe("Success");
      expect(yield* f.fs.exists(worktree)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: detached managed worktrees refuse archive with the keep command", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start({ worktree: f.repo, newWorktree: true });
      yield* f.wait();
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      yield* f.git(worktree, ["checkout", "--detach"]);
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining("detached HEAD"),
      });
      expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
        detail: expect.stringContaining("forman archive unit --keep-worktree"),
      });
      expect(yield* f.fs.exists(worktree)).toBe(true);
    }).pipe(Effect.provide(platform)),
  );
  it.effect("review: a clean but unconfirmed turn retains its worktree for later writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ method: Codex.Method.turnStart, respond: "none" }));
      yield* f.launch();
      const pending = yield* f
        .start({ worktree: f.repo, newWorktree: true })
        .pipe(Effect.flip, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.turnStart);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({
        detail: expect.stringContaining("retained"),
      });
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      yield* f.fs.writeFileString(`${worktree}/late.txt`, "late write");
      expect((yield* f.status()).state).toBe("unknown");
      expect(yield* f.fs.readFileString(`${worktree}/late.txt`)).toBe("late write");
    }).pipe(Effect.provide(platform)),
  );
  it.effect("diagnostics: an unconfirmed managed turn cannot be archived until inactive", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ method: Codex.Method.turnStart, respond: "none" }));
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(f.repo);
          return previous;
        }),
        () =>
          Effect.gen(function* () {
            const pending = yield* Effect.promise(() =>
              runCli(["start", "unit", "--new-worktree", "--contract", contract, "--json"], {
                env: { ...f.env, LOG_LEVEL: "none" },
              }),
            ).pipe(Effect.forkChild);
            yield* f.awaitLog(Codex.Method.turnStart);
            yield* TestClock.adjust("31 seconds");
            const result = yield* Fiber.join(pending);
            expect(result.status).toBe(5);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain(`${f.repo}/.claude/worktrees/unit`);
            expect(result.stderr).toContain("timed out");
            expect(result.stderr).toContain("wait until");
            expect(result.stderr).toContain("inactive");
            expect(result.stderr).toContain("forman archive unit --keep-worktree");
            expect(
              yield* f.request({ _tag: "Archive", name, keepWorktree: true }).pipe(Effect.flip),
            ).toMatchObject({ _tag: "RunConflict" });
            const archive = yield* Effect.promise(() =>
              runCli(["archive", "unit", "--keep-worktree", "--json"], {
                env: { ...f.env, LOG_LEVEL: "none" },
              }),
            );
            expect(archive.status).toBe(8);
            expect(archive.stdout).toBe("");
            expect(archive.stderr).toContain("unit");
            expect(archive.stderr).toContain("wait until");
          }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: an advancing branch survives archive's checked-tip deletion", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start({ worktree: f.repo, newWorktree: true });
      yield* f.wait();
      const advanced = (yield* f.git(f.repo, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "concurrent work",
      ])).stdout.trim();
      const realGit = (yield* commandResult(ChildProcess.make("which", ["git"]))).stdout.trim();
      yield* f.fs.writeFileString(
        `${f.root}/git`,
        `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = remove ]; then '${realGit}' -C '${f.repo}' update-ref refs/heads/forman/unit '${advanced}'; fi\nexec '${realGit}' "$@"\n`,
        { mode: 0o755 },
      );
      const previous = process.env.PATH;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.PATH = `${f.root}:${previous ?? ""}`;
        }),
        () =>
          Effect.gen(function* () {
            expect(yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip)).toMatchObject({
              _tag: "RunConflict",
              detail: expect.stringContaining("forman/unit"),
            });
            expect((yield* f.git(f.repo, ["rev-parse", "forman/unit"])).stdout.trim()).toBe(
              advanced,
            );
          }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.PATH;
            else process.env.PATH = previous;
          }),
      );
    }).pipe(Effect.provide(platform)),
  );
  it.live.each([false, true])(
    "review: peer completion during a mutation remains visible, CLI wait from another repo=%s",
    (cli) =>
      Effect.gen(function* () {
        const f = yield* fixture({
          onStart: [
            { awaitRequest: Codex.Method.turnSteer },
            notify(Codex.Method.turnCompleted, {
              threadId: "peer",
              turn: { id: "peer-turn", status: "completed", error: null, items: [] },
            }),
          ],
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "primary" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "peer" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "third" } } },
            },
            turnRule(),
            {
              ...turnRule(),
              respond: {
                result: { turn: { id: "peer-turn", status: "inProgress", error: null, items: [] } },
              },
            },
            turnRule(),
            {
              method: Codex.Method.turnSteer,
              delayMs: 300,
              respond: { result: { turnId: "{{turn}}" } },
            },
          ],
        });
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.launch();
        yield* f.start();
        yield* f.start({ name: otherName, worktree: other });
        const third = `${f.repo}/work/third`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "third", third]);
        yield* f.start({ name: Schema.decodeUnknownSync(D.RunName)("third"), worktree: third });
        if (cli) {
          const output = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
            yield* f.cli(["steer", name, "finish", "--wait", "--timeout", "1s", "--json"]),
          );
          expect(output).toMatchObject({
            _tag: "Waited",
            outcome: "timeout",
            runs: [],
          });
          if (output._tag !== "Waited") assert.fail("expected Waited");
          const replay = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
            yield* f.cli(["wait", "--all", "--after", output.cursor, "--timeout", "0ms", "--json"]),
          );
          expect(replay).toMatchObject({
            _tag: "Waited",
            runs: [{ name: otherName, kind: "done" }],
          });
          if (replay._tag !== "Waited") assert.fail("expected Waited");
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
              yield* f.cli([
                "wait",
                "--all",
                "--after",
                replay.cursor,
                "--timeout",
                "0ms",
                "--json",
              ]),
            ),
          ).toMatchObject({ runs: [] });
        } else {
          const accepted = yield* f.request({ _tag: "Steer", name, message: "finish" });
          if (accepted._tag !== "Accepted") assert.fail("expected Accepted");
          expect((yield* f.status(otherName)).state).toBe("idle");
          expect(
            (yield* f.wait({
              names: [],
              all: true,
              cwd: f.repo,
              after: accepted.cursor,
              timeoutMs: 0,
            })).runs,
          ).toMatchObject([{ name: otherName, kind: "done" }]);
        }
      }).pipe(Effect.provide(platform)),
  );
  it.live("orphan diagnostics skip worktree directories already removed outside Git", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      const orphan = `${f.repo}/.claude/worktrees/gone`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "forman/gone", orphan]);
      yield* f.fs.remove(orphan, { recursive: true });
      yield* f.launch();
      yield* f.start();
      yield* f.wait();
      expect(yield* f.request({ _tag: "Status", cwd: f.repo })).toMatchObject({
        _tag: "Digests",
        digests: [{ name }],
      });
    }).pipe(Effect.provide(platform)),
  );
  it.effect("a refused managed turn start retains work written before its timeout", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ method: Codex.Method.turnStart, respond: "none" }));
      yield* f.launch();
      const pending = yield* f
        .start({ worktree: f.repo, newWorktree: true })
        .pipe(Effect.flip, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.turnStart);
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      yield* f.fs.writeFileString(`${worktree}/result.txt`, "preserve");
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(pending);
      expect(error).toMatchObject({ detail: expect.stringContaining(worktree) });
      expect(yield* f.fs.readFileString(`${worktree}/result.txt`)).toBe("preserve");
      expect((yield* f.status()).warnings).toContainEqual(expect.stringContaining("retained"));
    }).pipe(Effect.provide(platform)),
  );
  it.live("a managed setup holds its own run lock without blocking another start", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario({ ...turnRule(), repeat: true }));
      yield* f.launch();
      yield* commandResult(ChildProcess.make("mkfifo", [`${f.root}/release`]));
      const first = yield* f
        .start({
          worktree: f.repo,
          newWorktree: true,
          setup: `printf ready > '${f.root}/ready'; cat '${f.root}/release'`,
        })
        .pipe(Effect.forkChild);
      while (!(yield* f.fs.exists(`${f.root}/ready`))) yield* Effect.yieldNow;
      yield* f
        .start({
          name: Schema.decodeUnknownSync(D.RunName)("other"),
          worktree: f.repo,
          newWorktree: true,
        })
        .pipe(
          Effect.timeout("2 seconds"),
          Effect.ensuring(f.fs.writeFileString(`${f.root}/release`, "go\n").pipe(Effect.orDie)),
        );
      expect(yield* Fiber.join(first)).toMatchObject({ _tag: "Started" });
    }).pipe(Effect.provide(platform)),
  );
  it.live("managed creation preserves an existing path", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const worktree = `${f.repo}/.claude/worktrees/unit`;
      yield* f.fs.makeDirectory(worktree, { recursive: true });
      yield* f.fs.writeFileString(`${worktree}/existing.txt`, "keep");
      yield* f.launch();
      expect(
        yield* f.start({ worktree: f.repo, newWorktree: true }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "WorktreeInvalid" });
      expect(yield* f.fs.readFileString(`${worktree}/existing.txt`)).toBe("keep");
      expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toBe("");
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: managed creation preserves an existing branch with an absent destination", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.git(f.repo, ["branch", "forman/unit"]);
      const tip = (yield* f.git(f.repo, ["rev-parse", "forman/unit"])).stdout;
      yield* f.launch();
      expect(
        yield* f.start({ worktree: f.repo, newWorktree: true }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "WorktreeInvalid" });
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
      expect((yield* f.git(f.repo, ["rev-parse", "forman/unit"])).stdout).toBe(tip);
    }).pipe(Effect.provide(platform)),
  );
  it.live("review: successful managed creation preserves an existing ignore rule", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule()));
      yield* f.fs.writeFileString(`${f.repo}/.gitignore`, ".claude/worktrees/\n");
      const exclude = yield* f.fs.readFileString(`${f.repo}/.git/info/exclude`);
      yield* f.launch();
      expect(yield* f.start({ worktree: f.repo, newWorktree: true })).toMatchObject({
        _tag: "Started",
      });
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(true);
      expect(yield* f.fs.readFileString(`${f.repo}/.git/info/exclude`)).toBe(exclude);
    }).pipe(Effect.provide(platform)),
  );
  it.live("managed hook-trust refusal rolls back the created worktree before thread/start", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      yield* f.fs.makeDirectory(`${f.repo}/.codex`);
      yield* f.fs.writeFileString(`${f.repo}/.codex/hooks.json`, '{"hooks":{}}');
      yield* f.fs.writeFileString(
        f.scenarioFile,
        Schema.encodeSync(Schema.fromJsonString(Scenario))(
          repoHooks(`${f.repo}/.claude/worktrees/unit`, `${f.repo}/.codex/hooks.json`, "untrusted"),
        ),
      );
      yield* f.launch();
      expect(
        yield* f.start({ worktree: f.repo, newWorktree: true }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RepoHooksUntrusted" });
      expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
      expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toBe("");
      expect((yield* f.readLog).some((entry) => entry.method === Codex.Method.threadStart)).toBe(
        false,
      );
    }).pipe(Effect.provide(platform)),
  );
  it.live.each(["Answer", "Steer", "Followup", "Interrupt"] as const)(
    "%s acceptance stays named while explicit group waits can still wake for a peer",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "primary" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "peer" } } },
            },
            turnRule(
              { Answer: [question()], Followup: [complete()], Steer: [], Interrupt: [] }[action],
            ),
            {
              ...turnRule(),
              respond: {
                result: { turn: { id: "peer-turn", status: "inProgress", error: null, items: [] } },
              },
            },
            turnRule(),
            {
              method: Codex.Method.turnSteer,
              repeat: true,
              respond: { result: { turnId: "{{turn}}" } },
              steps: [
                notify(Codex.Method.turnCompleted, {
                  threadId: "peer",
                  turn: { id: "peer-turn", status: "completed", error: null, items: [] },
                }),
              ],
            },
            {
              method: Codex.Method.turnInterrupt,
              respond: { result: {} },
              steps: [
                notify(Codex.Method.turnCompleted, {
                  threadId: "peer",
                  turn: { id: "peer-turn", status: "completed", error: null, items: [] },
                }),
              ],
            },
          ],
        });
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.launch();
        yield* f.start();
        if (action === "Answer" || action === "Followup") yield* f.wait();
        yield* f.start({ name: otherName, worktree: other });
        const requests: Record<typeof action, D.DaemonRequestBody> = {
          Answer: { _tag: "Answer", name, question: q1, text: "Proceed" },
          Interrupt: { _tag: "Interrupt", name },
          Followup: { _tag: "Followup", name, message: "Continue" },
          Steer: { _tag: "Steer", name, message: "Continue" },
        };
        const accepted = yield* f.request(requests[action]);
        if (accepted._tag !== "Accepted") assert.fail("expected Accepted");
        expect(accepted.all).toBeUndefined();
        const snapshot = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              group: Schema.String,
              positions: Schema.Record(Schema.String, Schema.Unknown),
            }),
          ),
        )(atob(accepted.cursor.replace(/^u1\./, "").replaceAll("-", "+").replaceAll("_", "/")));
        expect(snapshot.group).toBe(f.repo);
        expect(Object.keys(snapshot.positions)).toEqual(["unit"]);
        expect((yield* f.wait({ after: accepted.cursor, timeoutMs: 0 })).runs).toEqual([]);
        if (action === "Steer" || action === "Interrupt") {
          const first = yield* f.wait({
            names: [],
            all: true,
            cwd: f.repo,
            after: accepted.cursor,
          });
          expect(first.runs).toHaveLength(1);
          // The fake's current thread is 'other', so this proves a peer can wake the group.
          expect(first.runs[0]?.name).toBe(otherName);
          expect(
            (yield* f.wait({
              names: [],
              all: true,
              cwd: f.repo,
              after: first.cursor,
              timeoutMs: 0,
            })).runs,
          ).toEqual([]);
        } else {
          expect(
            (yield* f.wait({
              names: [],
              all: true,
              cwd: f.repo,
              after: accepted.cursor,
              timeoutMs: 0,
            })).runs,
          ).toEqual([]);
          yield* f.request({ _tag: "Steer", name: otherName, message: "finish" });
          expect(
            (yield* f.wait({ names: [], all: true, cwd: f.repo, after: accepted.cursor })).runs,
          ).toMatchObject([{ name: otherName, kind: "done" }]);
        }
      }).pipe(Effect.provide(platform)),
  );
  it.live.each([false, true])(
    "managed worktrees start from the caller HEAD or --from: %s",
    (from) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        const base = (yield* f.git(f.repo, ["rev-parse", "HEAD"])).stdout.trim();
        yield* f.git(f.worktree, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-qm",
          "caller",
        ]);
        const caller = (yield* f.git(f.worktree, ["rev-parse", "HEAD"])).stdout.trim();
        yield* f.launch();
        const worktree = `${f.repo}/.claude/worktrees/unit`;
        expect(
          yield* f.start({
            worktree: f.worktree,
            newWorktree: true,
            ...(from ? { from: base } : {}),
            setup: "mkdir node_modules; printf ready > node_modules/setup",
          }),
        ).toMatchObject({ _tag: "Started", worktree, branch: "forman/unit" });
        yield* f.wait();
        expect((yield* f.git(worktree, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          from ? base : caller,
        );
        expect(yield* f.fs.readFileString(`${worktree}/node_modules/setup`)).toBe("ready");
        expect(yield* f.fs.readFileString(`${f.repo}/.git/info/exclude`)).toContain(
          ".claude/worktrees/",
        );
        expect(yield* Store.readRun(f.runDir)).toMatchObject({
          managedWorktree: { branch: "forman/unit", baseCommit: from ? base : caller },
        });
      }).pipe(Effect.provide(platform)),
  );

  it.live.each(["setup", "preflight", "thread"] as const)(
    "managed worktrees roll back a refused %s start",
    (stage) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          stage === "thread"
            ? {
                rules: [
                  {
                    method: Codex.Method.threadStart,
                    respond: { error: { code: -1, message: "refused" } },
                  },
                ],
              }
            : scenario(),
        );
        if (stage === "preflight") {
          yield* f.fs.writeFileString(`${f.repo}/package.json`, "{}");
          yield* f.git(f.repo, ["add", "package.json"]);
          yield* f.git(f.repo, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "deps",
          ]);
        }
        yield* f.launch();
        const error = yield* f
          .start({
            worktree: f.repo,
            newWorktree: true,
            ...(stage === "setup" ? { setup: "printf 'setup tail\\n'; exit 23" } : {}),
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: stage === "thread" ? "RunConflict" : "WorktreeInvalid",
        });
        if (stage === "setup")
          expect(error).toMatchObject({
            detail: expect.stringMatching(/exit(?:ed)? 23[\s\S]*setup tail/),
          });
        expect(yield* f.fs.exists(`${f.repo}/.claude/worktrees/unit`)).toBe(false);
        expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toBe("");
        expect(yield* f.fs.exists(f.worktree)).toBe(true);
        if (stage !== "thread") expect(yield* f.readLog).toEqual([]);
      }).pipe(Effect.provide(platform)),
  );

  it.live.each(["clean", "merged", "dirty", "committed"] as const)(
    "managed archive protects work: %s",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()])));
        yield* f.launch();
        yield* f.start({ worktree: f.repo, newWorktree: true });
        yield* f.wait();
        const worktree = `${f.repo}/.claude/worktrees/unit`;
        if (kind !== "clean") yield* f.fs.writeFileString(`${worktree}/result.txt`, "work");
        if (kind === "merged" || kind === "committed") {
          yield* f.git(worktree, ["add", "result.txt"]);
          yield* f.git(worktree, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "work",
          ]);
        }
        if (kind === "merged") yield* f.git(f.repo, ["merge", "--ff-only", "forman/unit"]);
        if (kind === "dirty" || kind === "committed") {
          const error = yield* f.request({ _tag: "Archive", name }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "RunConflict",
            detail: expect.stringContaining(worktree),
          });
          expect(error).toMatchObject({ detail: expect.stringContaining("forman/unit") });
          expect(error).toMatchObject({
            detail: expect.stringContaining(kind === "dirty" ? "uncommitted" : "unmerged commits"),
          });
          expect(error).toMatchObject({
            detail: expect.stringContaining("forman archive unit --keep-worktree"),
          });
          yield* f.request({ _tag: "Archive", name, keepWorktree: true });
          expect(yield* f.fs.exists(worktree)).toBe(true);
          const status = yield* f.request({ _tag: "Status", cwd: f.repo });
          expect(status).toMatchObject({
            orphans: [{ path: worktree, branch: "forman/unit", holdsWork: true }],
          });
        } else {
          yield* f.request({ _tag: "Archive", name });
          expect(yield* f.fs.exists(worktree)).toBe(false);
          expect((yield* f.git(f.repo, ["branch", "--list", "forman/unit"])).stdout).toBe("");
        }
      }).pipe(Effect.provide(platform)),
  );

  it.effect("resilience: unknown recovery keeps its deadline when the state write fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ rules: [{ method: Codex.Method.threadStart, respond: "none" }] });
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.flip, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.threadStart);
      yield* f.fs.makeDirectory(`${f.runDir}/run.json.tmp`);
      yield* TestClock.adjust("180 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "CodexUnavailable" });
      expect((yield* f.status()).state).toBe("unknown");
      yield* f.fs.remove(`${f.runDir}/run.json.tmp`, { recursive: true });
      yield* TestClock.adjust("5 minutes");
      expect((yield* f.status()).state).toBe("lost");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("resilience: a detached Start still logs its failure once", () => {
    const records: LogEntry[] = [];
    const logger = Logger.make((input) =>
      records.push(
        entry({
          date: input.date,
          level: input.logLevel,
          message: input.message,
          annotations: input.fiber.getRef(References.CurrentLogAnnotations),
        }),
      ),
    );
    return Effect.gen(function* () {
      const f = yield* fixture({ rules: [{ method: Codex.Method.threadStart, respond: "none" }] });
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.forkChild);
      yield* f.awaitLog(Codex.Method.threadStart);
      yield* Fiber.interrupt(pending);
      yield* TestClock.adjust("180 seconds");
      expect((yield* f.status()).state).toBe("unknown");
      expect(records.filter(({ msg }) => msg === "supervisor.request.failed")).toMatchObject([
        { name: "unit", request: "Start", reasonTag: "CodexRequestTimeout" },
      ]);
    }).pipe(Effect.provide(platform), Effect.provide(Logger.layer([logger])));
  });

  it.live("resilience: dangling repo hooks still require a project hook event", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            notify(Codex.Method.itemStarted, {
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
      yield* f.fs.remove(`${f.repo}/.codex/hooks.json`);
      yield* f.fs.symlink(`${f.root}/missing-hooks`, `${f.repo}/.codex/hooks.json`);
      yield* f.launch();
      yield* f.start();
      expect((yield* f.wait()).runs).toMatchObject([
        {
          kind: "failed",
          digest: {
            failure: {
              message: expect.stringContaining(
                `repo hooks did not run in ${f.worktree}. Inspect ${f.repo}/.codex/hooks.json.`,
              ),
            },
          },
        },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["notification", "request", "recovery"])(
    "resilience: a %s persistence failure leaves the other run alive",
    (kind) =>
      Effect.gen(function* () {
        const primaryQuestion = {
          ...question("primary"),
          params: {
            threadId: "primary",
            turnId: "primary-turn",
            callId: "primary",
            namespace: null,
            tool: "ask_orchestrator",
            arguments: { question: "Primary?" },
          },
        };
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "primary" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "other" } } },
            },
            {
              ...turnRule(),
              respond: {
                result: {
                  turn: { id: "primary-turn", status: "inProgress", error: null, items: [] },
                },
              },
            },
            turnRule(),
            {
              method: Codex.Method.turnSteer,
              respond: { result: { turnId: "{{turn}}" } },
              steps: [
                kind === "request" ? primaryQuestion : notify("probe", { threadId: "primary" }),
                complete(),
              ],
            },
          ],
        });
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.launch();
        yield* f.start();
        yield* f.start({ name: otherName, worktree: other });
        yield* f.status();
        yield* f.fs.remove(`${f.runDir}/codex.jsonl`, { force: true });
        yield* f.fs.makeDirectory(`${f.runDir}/codex.jsonl`);
        if (kind === "recovery") yield* f.fs.makeDirectory(`${f.runDir}/run.json.tmp`);
        yield* f.request({ _tag: "Steer", name: otherName, message: "finish" });
        let damaged = yield* f.status();
        while (damaged.state === "running") {
          yield* Effect.yieldNow;
          damaged = yield* f.status();
        }
        expect(damaged).toMatchObject({
          state: "unknown",
          failure: {
            message: expect.stringMatching(
              /^Supervisor operation failed \(PlatformError: [^)]+\) for run unit at .+\. Run forman doctor and inspect .+ before retrying\.$/,
            ),
          },
        });
        expect((yield* Store.readRun(f.runDir)).activeTurnId).toBe("primary-turn");
        expect(
          yield* f
            .start({ name: Schema.decodeUnknownSync(D.RunName)("replacement") })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining("unknown") });
        expect((yield* f.wait({ names: [otherName] })).runs).toMatchObject([{ kind: "done" }]);
        expect(yield* f.request({ _tag: "Ping" })).toMatchObject({ _tag: "Pong" });
      }).pipe(Effect.provide(platform)),
  );

  it.live.each(["Start", "Followup"] as const)(
    "resilience: a %s defect fails only its run",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([complete()]), turnRule([complete()])));
        const { supervisor } = yield* f.launch();
        if (action === "Followup") {
          yield* f.start();
          yield* f.untilState("idle");
        }
        const body: D.DaemonRequestBody =
          action === "Start"
            ? {
                _tag: "Start",
                name,
                worktree: f.worktree,
                contract: "Work",
                write: false,
                skipDepsCheck: false,
              }
            : { _tag: "Followup", name, message: "Continue" };
        // Fault injection at the direct handler boundary, after this run has been registered.
        Object.defineProperty(body, action === "Start" ? "budgetMs" : "message", {
          get() {
            throw new TypeError("private defect message");
          },
        });
        expect(yield* supervisor.handler(body).pipe(Effect.flip)).toMatchObject({ _tag: "Defect" });
        expect((yield* f.status()).state).toBe("failed");
        expect((yield* f.wait({ timeoutMs: 0 })).runs).toMatchObject([{ kind: "failed" }]);
        expect(
          (yield* f.wait({ names: [], all: true, cwd: f.repo, timeoutMs: 0 })).runs,
        ).toMatchObject([{ kind: "failed" }]);
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.start({ name: otherName, worktree: other });
        expect((yield* f.wait({ names: [otherName] })).runs).toMatchObject([{ kind: "done" }]);
        expect(yield* f.request({ _tag: "Ping" })).toMatchObject({ _tag: "Pong" });
      }).pipe(Effect.provide(platform)),
  );

  it.effect("resilience: an expired question on a closed connection stays local", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const registry = yield* makeRegistry(f.dataDir);
      const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(D.RunRecord))(
        yield* f.fs.readFileString(
          fileURLToPath(new URL("./fixtures/runs/run.json", import.meta.url)),
        ),
      );
      const record = { ...stored, name, worktree: f.worktree, questionTimeoutMs: 1000 };
      yield* Store.createRun(f.dataDir, record, "Work");
      const run = yield* registry.add(record);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const connection = yield* openConnection({
        codexBin: fake,
        env: f.env,
        version: "test",
        stderr: () => Effect.void,
      }).pipe(Scope.provide(scope));
      const params = Schema.decodeUnknownSync(Codex.ToolCallParams)({
        threadId: "thread-a",
        turnId: "turn-2",
        callId: "q",
        namespace: null,
        tool: "ask_orchestrator",
        arguments: { question: "Choose?" },
      });
      const message = { id: 42, method: Codex.Method.toolCall, params };
      const questions = yield* makeQuestions(registry);
      yield* questions.receive(
        run,
        { connection, scope, generation: Symbol(), loaded: new Set() },
        message,
        params,
      );
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(1000);
      const recovered = Effect.gen(function* () {
        while ((yield* Store.readRun(run.dir)).state === "waiting") yield* Effect.yieldNow;
        return "recovered";
      });
      expect(
        yield* Effect.raceFirst(registry.failed.pipe(Effect.exit, Effect.as("stopped")), recovered),
      ).toBe("recovered");
      expect((yield* Store.readRun(run.dir)).state).toBe("unknown");
      expect(
        yield* Effect.raceFirst(
          registry.failed.pipe(Effect.as("stopped")),
          registry.busy.pipe(Effect.as("alive")),
        ),
      ).toBe("alive");
    }).pipe(Effect.provide(platform)),
  );

  it.live("release C6: a pending question cannot be answered on a replacement connection", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const registry = yield* makeRegistry(f.dataDir);
      const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(D.RunRecord))(
        yield* f.fs.readFileString(
          fileURLToPath(new URL("./fixtures/runs/run.json", import.meta.url)),
        ),
      );
      const record = { ...stored, name, worktree: f.worktree };
      yield* Store.createRun(f.dataDir, record, "Work");
      const run = yield* registry.add(record);
      const open = Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Effect.scope);
        const connection = yield* openConnection({
          codexBin: fake,
          env: f.env,
          version: "test",
          stderr: () => Effect.void,
        }).pipe(Scope.provide(scope));
        return { scope, connection, generation: Symbol(), loaded: new Set<string>() };
      });
      const origin = yield* open;
      const replacement = yield* open;
      const params = Schema.decodeUnknownSync(Codex.ToolCallParams)({
        threadId: "thread-a",
        turnId: "turn-2",
        callId: "q",
        namespace: null,
        tool: "ask_orchestrator",
        arguments: { question: "Choose?" },
      });
      const questions = yield* makeQuestions(registry);
      yield* questions.receive(
        run,
        origin,
        { id: 42, method: Codex.Method.toolCall, params },
        params,
      );
      yield* Scope.close(origin.scope, Exit.void);
      expect(
        (yield* questions.resolve(run, replacement, q1, "A", "answered").pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(Store.pendingQuestions(yield* Store.readQuestions(run.dir))).toHaveLength(1);
      expect((yield* f.readLog).filter((message) => message.result !== undefined)).toHaveLength(0);
    }).pipe(Effect.provide(platform)),
  );

  it.live("release C7: answer delivery completes bookkeeping despite caller interruption", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario());
      const registry = yield* makeRegistry(f.dataDir);
      const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(D.RunRecord))(
        yield* f.fs.readFileString(
          fileURLToPath(new URL("./fixtures/runs/run.json", import.meta.url)),
        ),
      );
      const record = { ...stored, name, worktree: f.worktree };
      yield* Store.createRun(f.dataDir, record, "Work");
      const run = yield* registry.add(record);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const opened = yield* openConnection({
        codexBin: fake,
        env: f.env,
        version: "test",
        stderr: () => Effect.void,
      }).pipe(Scope.provide(scope));
      const delivered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Hold the third-party transport after its real response write, before local persistence.
      const connection = {
        ...opened,
        respond: (id: Codex.RpcId, result: unknown) =>
          opened
            .respond(id, result)
            .pipe(
              Effect.andThen(Deferred.succeed(delivered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.as(undefined),
            ),
      };
      const server = { scope, connection, generation: Symbol(), loaded: new Set<string>() };
      const params = Schema.decodeUnknownSync(Codex.ToolCallParams)({
        threadId: "thread-a",
        turnId: "turn-2",
        callId: "q",
        namespace: null,
        tool: "ask_orchestrator",
        arguments: { question: "Choose?" },
      });
      const questions = yield* makeQuestions(registry);
      yield* questions.receive(
        run,
        server,
        { id: 42, method: Codex.Method.toolCall, params },
        params,
      );
      const pending = yield* questions
        .resolve(run, server, q1, "A", "answered")
        .pipe(Effect.forkChild);
      yield* Deferred.await(delivered);
      yield* opened.request("flush", {}, Schema.Unknown).pipe(Effect.result);
      const disconnected = yield* Fiber.interrupt(pending).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(disconnected);
      expect(Store.pendingQuestions(yield* Store.readQuestions(run.dir))).toEqual([]);
      expect(yield* Store.readQuestions(run.dir)).toMatchObject([
        { _tag: "Asked" },
        { resolution: "answered", text: "A" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "release C7: a delivered answer cannot be resent after resolution persistence fails",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario());
        const registry = yield* makeRegistry(f.dataDir);
        const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(D.RunRecord))(
          yield* f.fs.readFileString(
            fileURLToPath(new URL("./fixtures/runs/run.json", import.meta.url)),
          ),
        );
        const record = { ...stored, name, worktree: f.worktree };
        yield* Store.createRun(f.dataDir, record, "Work");
        const run = yield* registry.add(record);
        const scope = yield* Scope.fork(yield* Effect.scope);
        const opened = yield* openConnection({
          codexBin: fake,
          env: f.env,
          version: "test",
          stderr: () => Effect.void,
        }).pipe(Scope.provide(scope));
        let inject = true;
        const file = `${run.dir}/questions.jsonl`;
        const connection = {
          ...opened,
          respond: (id: Codex.RpcId, result: unknown) =>
            Effect.gen(function* () {
              yield* opened.respond(id, result);
              if (inject) {
                inject = false;
                yield* Effect.sync(() => {
                  renameSync(file, `${file}.saved`);
                  mkdirSync(file);
                });
              }
              return undefined;
            }),
        };
        const server = { scope, connection, generation: Symbol(), loaded: new Set<string>() };
        const params = Schema.decodeUnknownSync(Codex.ToolCallParams)({
          threadId: "thread-a",
          turnId: "turn-2",
          callId: "q",
          namespace: null,
          tool: "ask_orchestrator",
          arguments: { question: "Choose?" },
        });
        const questions = yield* makeQuestions(registry);
        yield* questions.receive(
          run,
          server,
          { id: 42, method: Codex.Method.toolCall, params },
          params,
        );
        expect(
          (yield* questions.resolve(run, server, q1, "A", "answered").pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.fs.remove(file, { recursive: true });
        yield* f.fs.rename(`${file}.saved`, file);
        expect(
          (yield* questions.resolve(run, server, q1, "A", "answered").pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* opened.request("flush", {}, Schema.Unknown).pipe(Effect.result);
        expect((yield* f.readLog).filter((message) => message.result !== undefined)).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(platform)),
  );

  it.live.each([false, true])("resilience: interrupt continues after turn 1, wait=%s", (waiting) =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([complete()]), turnRule(), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      yield* f.launch();
      yield* f.start();
      yield* f.wait();
      yield* f.request({ _tag: "Followup", name, message: "turn two" });
      const stdout = yield* f.cli([
        "interrupt",
        "unit",
        ...(waiting ? ["--wait", "--timeout", "2s"] : []),
        "--json",
      ]);
      let result = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(stdout);
      if (!waiting) {
        if (result._tag !== "Accepted" || !result.next) assert.fail("expected a continuation");
        expect(result.next).toContain(" wait unit --after ");
        result = yield* f.wait({ after: result.cursor });
      }
      expect(result).toMatchObject({
        _tag: "Waited",
        runs: [{ kind: "interrupted", summary: "turn 2" }],
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["notification", "question"])(
    "resilience: a slow digest does not delay another run's %s",
    (kind) =>
      Effect.gen(function* () {
        const primaryQuestion = {
          ...question("primary"),
          params: {
            threadId: "primary",
            turnId: "primary-turn",
            callId: "primary",
            namespace: null,
            tool: "ask_orchestrator",
            arguments: { question: "Primary?" },
          },
        };
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "primary" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "other" } } },
            },
            {
              ...turnRule(),
              respond: {
                result: {
                  turn: { id: "primary-turn", status: "inProgress", error: null, items: [] },
                },
              },
            },
            turnRule(),
            {
              method: Codex.Method.turnSteer,
              respond: { result: { turnId: "{{turn}}" } },
              steps:
                kind === "notification"
                  ? [notify("held", { threadId: "primary" }), complete()]
                  : [primaryQuestion, question("other")],
            },
          ],
        });
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.launch();
        yield* f.start();
        yield* f.start({ name: otherName, worktree: other });
        const file = `${f.runDir}/baseline.txt`;
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
        const slow = yield* f.status().pipe(Effect.forkChild);
        yield* Deferred.await(held);
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        yield* f.request({ _tag: "Steer", name: otherName, message: "signal both" });
        const waited = yield* f.wait({ names: [otherName], timeoutMs: 1000 });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(writer);
        yield* f.fs.remove(file);
        yield* f.fs.writeFileString(file, original);
        yield* Fiber.join(slow);
        expect(waited.runs).toMatchObject([
          { kind: kind === "notification" ? "done" : "question" },
        ]);
      }).pipe(Effect.provide(platform)),
  );

  it.live(
    "resilience: removing one active worktree leaves the daemon and the other run alive",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          rules: [
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "primary" } } },
            },
            {
              method: Codex.Method.threadStart,
              respond: { result: { ...opened, thread: { id: "other" } } },
            },
            {
              ...turnRule([
                { awaitRequest: Codex.Method.turnSteer },
                notify(Codex.Method.turnCompleted, {
                  threadId: "primary",
                  turn: { id: "primary-turn", status: "completed", error: null, items: [] },
                }),
              ]),
              respond: {
                result: {
                  turn: { id: "primary-turn", status: "inProgress", error: null, items: [] },
                },
              },
            },
            turnRule([{ awaitRequest: Codex.Method.turnSteer }, complete()]),
            { method: Codex.Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } },
          ],
        });
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        yield* f.launch();
        yield* f.start();
        yield* f.start({ name: otherName, worktree: other });
        yield* f.git(f.repo, ["worktree", "remove", "--force", f.worktree]);
        yield* f.request({ _tag: "Steer", name: otherName, message: "finish both" });
        expect((yield* f.untilState("idle")).warnings).toContain(`worktree removed: ${f.worktree}`);
        expect((yield* f.wait({ names: [otherName] })).runs).toMatchObject([{ kind: "done" }]);
        expect(yield* f.request({ _tag: "Ping" })).toMatchObject({ _tag: "Pong" });
      }).pipe(Effect.provide(platform)),
  );

  it.live.each(["events.jsonl", "questions.jsonl"])(
    "resilience: restart repairs a torn %s tail",
    (file) =>
      Effect.gen(function* () {
        const f = yield* fixture(scenario(turnRule([question()])));
        const first = yield* f.launch();
        yield* f.start();
        yield* f.wait();
        yield* first.stop;
        yield* f.fs.writeFileString(`${f.runDir}/${file}`, '{"torn":', { flag: "a" });
        yield* f.launch();
        expect((yield* f.status()).state).toBe("lost");
        expect(Store.pendingQuestions(yield* Store.readQuestions(f.runDir))).toEqual([]);
        expect((yield* Store.readEvents(f.runDir)).events.at(-1)?.event).toMatchObject({
          _tag: "StateChanged",
          to: "lost",
        });
      }).pipe(Effect.provide(platform)),
  );

  it.live("resilience: skips a run whose recovery fails and recovers the other run", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule(), turnRule()));
      const otherName = Schema.decodeUnknownSync(D.RunName)("other");
      const other = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      const first = yield* f.launch();
      yield* f.start();
      yield* f.start({ name: otherName, worktree: other });
      yield* first.stop;
      yield* Store.writeRun(f.runDir, { ...(yield* Store.readRun(f.runDir)), state: "running" });
      yield* f.fs.writeFileString(`${f.runDir}/questions.jsonl`, "broken complete line\n");
      yield* f.launch();
      expect((yield* f.status(otherName)).state).toBe("lost");
      expect(yield* f.status().pipe(Effect.flip)).toMatchObject({
        _tag: "RunConflict",
        detail: expect.stringContaining(f.runDir),
      });
      expect(yield* f.request({ _tag: "Status", cwd: f.worktree })).toMatchObject({
        digests: [{ name: "other" }],
        skipped: [{ path: f.runDir }],
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live("resilience: preserves an unregistered half-created run directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.fs.makeDirectory(f.runDir, { recursive: true });
      yield* f.fs.writeFileString(`${f.runDir}/contract.md`, "crashed before run.json");
      yield* f.launch();
      expect(yield* f.start().pipe(Effect.flip)).toMatchObject({ _tag: "RunConflict" });
      expect(yield* f.fs.readFileString(`${f.runDir}/contract.md`)).toBe("crashed before run.json");
    }).pipe(Effect.provide(platform)),
  );

  it.live.each(["Followup", "Archive"] as const)(
    "resilience: a queued %s on a stalled Start does not delay unrelated runs",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture({
          rules: [
            { method: Codex.Method.threadStart, respond: "none" },
            { method: Codex.Method.threadStart, respond: { result: opened } },
            turnRule([complete()]),
            turnRule([question()]),
          ],
        });
        const otherName = Schema.decodeUnknownSync(D.RunName)("other");
        const other = `${f.repo}/work/other`;
        yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
        const { supervisor } = yield* f.launch();
        yield* f.start().pipe(Effect.forkChild);
        yield* f.awaitLog(Codex.Method.threadStart);
        const blocked: D.DaemonRequestBody =
          action === "Followup"
            ? { _tag: "Followup", name, message: "queued" }
            : { _tag: "Archive", name };
        yield* supervisor
          .handler(blocked)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        expect(
          yield* f.start({ name: otherName, worktree: other }).pipe(Effect.timeout("2 seconds")),
        ).toMatchObject({ _tag: "Started" });
        yield* f.wait({ names: [otherName] });
        const accepted = yield* f.request({ _tag: "Followup", name: otherName, message: "next" });
        if (accepted._tag !== "Accepted") assert.fail("expected Accepted");
        expect((yield* f.wait({ names: [otherName], after: accepted.cursor })).runs).toMatchObject([
          { kind: "question" },
        ]);
      }).pipe(Effect.provide(platform)),
  );

  for (const json of [false, true]) {
    for (const kind of ["done", "question"] as const) {
      it.live(`start --wait returns ${kind}, json=${json}`, () =>
        Effect.gen(function* () {
          const f = yield* fixture(
            scenario(
              turnRule(
                kind === "question"
                  ? [question()]
                  : [complete("completed", [message("Finished work.")])],
              ),
            ),
          );
          yield* f.launch();
          const contract = `${f.root}/contract.md`;
          yield* f.fs.writeFileString(contract, "Do the work.");
          const stdout = yield* f.cli([
            "start",
            "unit",
            "--worktree",
            f.worktree,
            "--contract",
            contract,
            "--wait",
            "--timeout",
            "2s",
            ...(json ? ["--json"] : []),
          ]);
          if (json) {
            const result = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(stdout);
            expect(result).toMatchObject({
              _tag: "Waited",
              runs: [{ kind }],
              started: { name, runDir: f.runDir },
            });
            if (kind === "done")
              expect(result).toMatchObject({ runs: [{ handoff: { text: "Finished work." } }] });
          } else {
            expect(stdout).toContain(`unit\n${f.runDir}\n${kind.padEnd(12)}unit`);
            expect(stdout).not.toContain("next: forman wait unit\n");
            if (kind === "done") expect(stdout).toContain("Hand-off (turn 1):\nFinished work.");
          }
          if (kind === "done") expect(stdout).toContain(" --timeout 2s");
          else {
            expect(stdout).toContain(`forman answer unit q1`);
            expect(stdout).toContain(`forman defer unit q1`);
            expect(stdout).not.toContain(" --timeout 2s");
          }
        }).pipe(Effect.provide(platform)),
      );
    }
    for (const command of ["answer", "followup", "steer"] as const) {
      for (const waiting of [false, true]) {
        it.live.each([false, true])(
          `${command} ${waiting ? "--wait returns" : "prints a wait for"} fresh attention, json=${json}, legacy=%s`,
          (legacy) =>
            Effect.gen(function* () {
              const scripts = {
                answer: scenario(
                  turnRule([
                    question(),
                    { awaitResponse: "q" },
                    question("second", { question: "Next decision?" }),
                  ]),
                ),
                followup: scenario(turnRule([complete()]), turnRule([question()])),
                steer: scenario(
                  turnRule([complete()]),
                  turnRule([
                    { awaitRequest: Codex.Method.turnSteer },
                    complete("completed", [message("Steered work.")]),
                  ]),
                  {
                    method: Codex.Method.turnSteer,
                    respond: { result: { turnId: "{{turn}}" } },
                  },
                ),
              };
              const f = yield* fixture(scripts[command], legacy);
              yield* f.launch();
              yield* f.start();
              yield* f.wait();
              if (command === "steer") {
                yield* f.request({ _tag: "Followup", name, message: "Continue" });
                yield* f.untilState("running");
              }
              const stdout = yield* f.cli([
                command,
                "unit",
                ...(command === "answer" ? ["q1"] : []),
                "Proceed",
                ...(waiting ? ["--wait", "--timeout", "2s"] : []),
                ...(json ? ["--json"] : []),
              ]);
              let outcome = stdout;
              if (!waiting) {
                const next = json
                  ? Schema.decodeUnknownSync(Schema.Struct({ next: Schema.String }))(
                      JSON.parse(stdout),
                    ).next
                  : stdout.trimEnd().split("\n").at(-1)?.slice("next: ".length);
                expect(f.nextArgs(next ?? "").join(" ")).toMatch(/^wait unit --after \S+$/);
                if (!json) expect(stdout).toMatch(/^ok\nnext: /);
                outcome = yield* f.cli([
                  ...f.nextArgs(next ?? ""),
                  "--timeout",
                  "2s",
                  ...(json ? ["--json"] : []),
                ]);
              }
              const kind = command === "steer" ? "done" : "question";
              if (json) {
                const result = Schema.decodeUnknownSync(Schema.fromJsonString(D.DaemonResult))(
                  outcome,
                );
                expect(result).toMatchObject({
                  _tag: "Waited",
                  runs: [{ kind, digest: { turn: command === "answer" ? 1 : 2 } }],
                });
                if (command === "answer")
                  expect(result).toMatchObject({
                    runs: [{ summary: "q2 (question): Next decision?" }],
                  });
              } else {
                expect(outcome).toContain(`${kind.padEnd(12)}unit`);
                if (command === "answer") {
                  expect(outcome).toContain("q2 (question): Next decision?");
                  expect(outcome).not.toContain("q1");
                } else expect(outcome).toMatch(/turn: +2 \(followup\)/);
              }
            }).pipe(Effect.provide(platform)),
        );
      }
    }
  }

  it.live.each(["failed", "interrupted"])("includes the %s turn's own hand-off", (status) =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule([complete(status, [message("Partial work.\nNext steps.")])])),
      );
      yield* f.launch();
      yield* f.start();
      expect((yield* f.wait()).runs).toMatchObject([
        { kind: status, handoff: { turn: 1, text: "Partial work.\nNext steps." } },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("preserves multiple wait names and continues their cursor through the real CLI", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()]), turnRule([question()])));
      const otherName = Schema.decodeUnknownSync(D.RunName)("other");
      const otherWorktree = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", otherWorktree]);
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      yield* f.start({ name: otherName, worktree: otherWorktree });
      yield* f.wait({ names: [otherName] });
      const first = yield* f.cli(["wait", "unit", "other"]);
      expect(first).toContain(`next: FORMAN_HOME=${f.dataDir} forman answer other q1 "<answer>"`);
      expect(first).toContain(`or: FORMAN_HOME=${f.dataDir} forman defer other q1`);
      const cursor = first
        .split("\n")
        .find((line) => line.startsWith("cursor: "))
        ?.slice(8);
      expect(cursor).toBeDefined();
      const continued = yield* f.cli([
        "wait",
        "unit",
        "other",
        "--after",
        cursor ?? "",
        "--timeout",
        "0ms",
        "--json",
      ]);
      const result = Schema.decodeUnknownSync(D.DaemonResult)(JSON.parse(continued));
      assert(result._tag === "Waited");
      expect(result).toMatchObject({
        outcome: "timeout",
        runs: [],
        next: `FORMAN_HOME=${f.dataDir} forman wait unit other --after ${result.cursor} --timeout 0ms`,
      });
    }).pipe(Effect.provide(platform)),
  );

  it.live(
    "continues from printed named wait commands through timeout, question and done without replay",
    () =>
      Effect.gen(function* () {
        const longQuestion = `${"Full question text. ".repeat(400)}\nChoose A or B?`;
        const f = yield* fixture(
          scenario(
            turnRule([
              question("q", { question: longQuestion, kind: "blocked" }),
              { awaitResponse: "q" },
              complete("completed", [message("Finished.\nAll checks passed.")]),
            ]),
          ),
        );
        yield* f.launch();
        yield* f.start();
        yield* f.untilState("waiting");
        const first = yield* f.cli(["wait", "unit", "--timeout", "0ms"]);
        expect(first).toContain(longQuestion);
        const continuation = (text: string) => {
          const line = text.trimEnd().split("\n").at(-1);
          expect(f.nextArgs((line ?? "").slice("next: ".length)).join(" ")).toMatch(
            /^wait unit --after \S+ --timeout 0ms$/,
          );
          return f.nextArgs((line ?? "").slice("next: ".length));
        };
        expect(first).toContain(`next: FORMAN_HOME=${f.dataDir} forman answer unit q1 "<answer>"`);
        expect(first).toContain(`or: FORMAN_HOME=${f.dataDir} forman defer unit q1`);
        const cursor = first
          .split("\n")
          .find((line) => line.startsWith("cursor: "))
          ?.slice(8);
        expect(cursor).toBeDefined();
        const next = ["wait", "unit", "--after", cursor ?? "", "--timeout", "0ms"];
        const timed = yield* f.cli(next);
        expect(timed.split("\n")[0]).toBe("timeout");
        expect(continuation(timed)).toEqual(next);
        yield* f.cli(["answer", "unit", "q1", "A"]);
        yield* f.untilState("idle");
        const done = yield* f.cli(continuation(timed));
        expect(done).toContain("done        unit turn 1");
        expect(done).toContain("Hand-off (turn 1):\nFinished.\nAll checks passed.");
        expect(done).not.toContain("question    unit");
        const afterDone = yield* f.cli([...continuation(done), "--json"]);
        const result = Schema.decodeUnknownSync(D.DaemonResult)(JSON.parse(afterDone));
        assert(result._tag === "Waited");
        expect(result).toMatchObject({
          outcome: "timeout",
          runs: [],
          next: `FORMAN_HOME=${f.dataDir} forman wait unit --after ${result.cursor} --timeout 0ms`,
        });
      }).pipe(Effect.provide(platform)),
  );

  it.effect("measures active time and freezes inactive time through TestClock", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(turnRule(), {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [complete("interrupted")],
        }),
      );
      const { supervisor } = yield* f.launch();
      yield* f.start();
      yield* f.untilState("running");
      yield* TestClock.adjust("65 seconds");
      expect((yield* f.status()).elapsedMs).toBe(65_000);
      yield* f.request({ _tag: "Interrupt", name });
      yield* f.untilState("interrupted");
      yield* TestClock.adjust("1 hour");
      const stopped = yield* supervisor.handler({ _tag: "Status", name, cwd: f.worktree });
      expect(stopped).toMatchObject({ digests: [{ elapsedMs: 65_000 }] });
    }).pipe(Effect.provide(platform)),
  );
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
      // The spawn diagnostic identifies the missing worktree and command.
      expect(yield* computeWorktreeFields(f.worktree, f.runDir).pipe(Effect.flip)).toMatchObject({
        _tag: "WorktreeInvalid",
        detail: expect.stringContaining("NotFound"),
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
        _tag: "RunConflict",
        detail: expect.stringContaining("run data"),
      });
      expect(JSON.stringify(error)).not.toContain("secret=private invalid JSON");
      if (kind === "platform") {
        const result = yield* Effect.promise(() =>
          runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
        );
        expect(result.status).toBe(8);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("unit");
        expect(result.stderr).toContain(`${f.runDir}/baseline.txt`);
        expect(result.stderr).toContain("permissions");
      }
    }).pipe(Effect.provide(platform)),
  );

  it.live("diagnostics: unreadable run files use the permission exit and name the file", () =>
    Effect.gen(function* () {
      const f = yield* fixture(scenario(turnRule([complete()])));
      yield* f.launch();
      yield* f.start();
      yield* f.untilState("idle");
      const file = `${f.runDir}/baseline.txt`;
      yield* f.fs.chmod(file, 0);
      yield* Effect.addFinalizer(() => f.fs.chmod(file, 0o600).pipe(Effect.orDie));
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(6);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain(file);
      expect(result.stderr).toContain("permissions");
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
        _tag: "RunConflict",
        detail: expect.stringContaining("Codex refused"),
      });
      expect(JSON.stringify(error)).not.toContain("private");
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const result = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("status");
      expect(result.stderr).not.toContain("secret=private");
    }).pipe(Effect.provide(platform)),
  );

  it.live("diagnostics: followup after a refused thread names the run and next step", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        rules: [
          {
            method: Codex.Method.threadStart,
            respond: { error: { code: -1, message: "refused" } },
          },
        ],
      });
      yield* f.launch();
      yield* f.start().pipe(Effect.result);
      const result = yield* Effect.promise(() =>
        runCli(["followup", "unit", "continue", "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("forman start --help");
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

  it.live("names the run and executable when a Codex reply is invalid", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario({
          method: Codex.Method.turnStart,
          respond: { result: { turn: { status: 123, error: null, items: [] } } },
        }),
      );
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const result = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(5);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain(f.env.CODEX_BIN);
      expect(result.stderr).toContain("forman doctor");
    }).pipe(Effect.provide(platform)),
  );

  it.live("explains an app-server exit while starting a run", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ ...scenario(), onStart: [{ exit: 17 }] });
      yield* f.launch();
      const contract = `${f.root}/contract.md`;
      yield* f.fs.writeFileString(contract, "work");
      const result = yield* Effect.promise(() =>
        runCli(["start", "unit", "--worktree", f.worktree, "--contract", contract, "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(5);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unit");
      expect(result.stderr).toContain("17");
      expect(result.stderr).toContain("forman doctor");
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
      // Events takes the run lock, so seeing TurnStarted also waits for its record writes.
      while (true) {
        const events = yield* f.request({ _tag: "Events", name });
        if (
          events._tag === "Events" &&
          events.events.some(({ event }) => event._tag === "TurnStarted")
        )
          break;
        yield* Effect.yieldNow;
      }
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
        expect((yield* f.status()).warnings).toContainEqual(
          expect.stringContaining(
            `Could not check the Codex protocol for ${JSON.stringify(f.env.CODEX_BIN)}:`,
          ),
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
      const result = yield* Effect.promise(() =>
        runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Budget expired for run unit");
      expect(result.stdout).toContain("forman wait unit");
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
      const result = yield* Effect.promise(() =>
        runCli(["followup", "unit", "continue", "--json"], {
          env: { ...f.env, LOG_LEVEL: "none" },
        }),
      );
      expect(result.status).toBe(8);
      expect(result.stdout).toBe("");
      expect.soft(result.stderr).toContain("unit");
      expect.soft(result.stderr).toContain(f.worktree);
      expect.soft(result.stderr).toContain("start a new run");
      for (const command of ["interrupt", "steer"] as const) {
        const refused = yield* Effect.promise(() =>
          runCli([command, "unit", ...(command === "steer" ? ["change"] : []), "--json"], {
            env: { ...f.env, LOG_LEVEL: "none" },
          }),
        );
        expect.soft(refused.status).toBe(8);
        expect.soft(refused.stdout).toBe("");
        expect.soft(refused.stderr).toContain("unit");
        expect.soft(refused.stderr).toContain("forman status unit");
        expect.soft(refused.stderr).not.toContain("send a followup");
      }
    }).pipe(Effect.provide(platform)),
  );
  it.live.each([
    { case: "detailed shape has changed", turnId: "{{turn}}", item: { id: "cmd" } },
    { case: "item id is missing", turnId: "{{turn}}", item: {} },
    { case: "turn id is unfamiliar", turnId: "other-turn", item: { id: "cmd" } },
  ])("fails closed when a commandExecution item's $case", ({ turnId, item }) =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([
            notify(Codex.Method.itemStarted, {
              threadId: "{{thread}}",
              turnId,
              item: { type: "commandExecution", ...item, newCommandField: "true" },
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
      while (!(yield* f.fs.exists(`${f.runDir}/codex.jsonl`))) yield* Effect.yieldNow;
      while (!(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).includes("newCommandField"))
        yield* Effect.yieldNow;
      const digest = yield* f.status();
      expect(digest.failure?.message).toContain(
        `repo hooks did not run in ${f.worktree}. Inspect ${f.repo}/.codex/hooks.json.`,
      );
    }).pipe(Effect.provide(platform)),
  );
  it.effect("a late malformed command still enforces hooks after an unconfirmed turn start", () =>
    Effect.gen(function* () {
      const script = scenario(
        {
          method: Codex.Method.turnStart,
          respond: "none",
          steps: [
            { awaitRequest: Codex.Method.hooksList },
            notify(Codex.Method.itemStarted, {
              threadId: "primary",
              turnId: "late-turn",
              item: { type: "commandExecution", id: "cmd", newCommandField: "true" },
            }),
          ],
        },
        turnRule(),
        {
          method: Codex.Method.turnInterrupt,
          respond: { result: {} },
          steps: [
            notify(Codex.Method.turnCompleted, {
              threadId: "primary",
              turn: { id: "late-turn", status: "interrupted", error: null, items: [] },
            }),
          ],
        },
      );
      const f = yield* fixture({
        rules: [
          {
            method: Codex.Method.threadStart,
            respond: { result: { ...opened, thread: { id: "primary" } } },
          },
          ...script.rules,
        ],
      });
      yield* f.hooks;
      yield* f.launch();
      const pending = yield* f.start().pipe(Effect.result, Effect.forkChild);
      yield* f.awaitLog(Codex.Method.turnStart);
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect((yield* f.status()).state).toBe("unknown");
      const other = `${f.repo}/work/other`;
      yield* f.git(f.repo, ["worktree", "add", "-qb", "other", other]);
      yield* f
        .start({ name: Schema.decodeUnknownSync(D.RunName)("other"), worktree: other })
        .pipe(Effect.result);
      while (!(yield* f.fs.exists(`${f.runDir}/codex.jsonl`))) yield* Effect.yieldNow;
      while (!(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).includes("newCommandField"))
        yield* Effect.yieldNow;
      expect((yield* f.status()).failure?.message).toContain(
        `repo hooks did not run in ${f.worktree}. Inspect ${f.repo}/.codex/hooks.json.`,
      );
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
    "marks active runs lost on a crash and records the resumed sandbox without a tool warning",
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
        expect((yield* Store.readEvents(f.runDir)).events.map(({ event }) => event)).toContainEqual(
          {
            _tag: "Resumed",
            sandbox: "readOnly",
            model: opened.model,
          },
        );
        expect(digest.warnings).toContain(
          "resumed with sandbox readOnly, run expects dangerFullAccess",
        );
        expect(digest.warnings.join(" ")).not.toMatch(/questions may not reach Claude/i);
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
          next: `forman wait unit --after ${asked.cursor}`,
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
        expect(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).toContain(
          Codex.Method.turnCompleted,
        );
        expect(yield* f.fs.readFileString(`${f.runDir}/codex.jsonl`)).toContain("changed upstream");
        const result = yield* Effect.promise(() =>
          runCli(["status", "unit", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(Codex.Method.tokenUsageUpdated);
        expect(result.stdout).toContain(Codex.Method.turnCompleted);
        expect(result.stdout).toContain("forman doctor");
        expect(result.stdout).not.toContain("changed upstream");
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
            handoff: { turn: 1, text: "Created result.txt." },
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
          next: `forman wait --all --after ${waited.cursor}`,
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
      const error = yield* f.request({ _tag: "Steer", name, message: "late" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "RunConflict", detail: expect.stringContaining("unit") });
      expect(error).toMatchObject({ detail: expect.stringContaining("forman status unit") });
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

  it.live("holds questions, refuses steer, answers the RPC once, and accepts a correction", () =>
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
        detail:
          'unit is waiting on q1; use forman answer unit q1 "<answer>" and include the change.',
      });
      yield* f.request({ _tag: "Answer", name, question: q1, text: "Take path A" });
      expect((yield* f.status()).state).toBe("running");
      expect(yield* f.request({ _tag: "Answer", name, question: q1, text: "twice" })).toMatchObject(
        { _tag: "Accepted", delivery: "steer" },
      );
      expect((yield* f.wait({ after: waited.cursor })).runs).toMatchObject([{ kind: "done" }]);
      expect(yield* f.readLog).toContainEqual({
        result: { success: true, contentItems: [{ type: "inputText", text: "Take path A" }] },
      });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked", id: "q1", turn: 1 },
        { _tag: "Resolved", resolution: "answered", text: "Take path A" },
        { _tag: "Resolved", resolution: "correction", text: "twice", delivery: "steer" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.effect("defers on the question timeout through TestClock", () =>
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
        result: { success: true, contentItems: [{ type: "inputText", text: deferral }] },
      });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked" },
        { _tag: "Deferred", by: "timeout" },
      ]);
    }).pipe(Effect.provide(platform)),
  );

  it.live("cancels held questions on interrupt and delivers a later answer in a follow-up", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        scenario(
          turnRule([question()]),
          {
            method: Codex.Method.turnInterrupt,
            respond: { result: {} },
            steps: [complete("interrupted")],
          },
          turnRule([complete()]),
        ),
      );
      const { supervisor } = yield* f.launch();
      yield* f.start();
      const asked = yield* f.wait();
      yield* f.request({ _tag: "Interrupt", name });
      expect((yield* f.wait({ after: asked.cursor })).runs).toMatchObject([
        { kind: "interrupted" },
      ]);
      expect(yield* supervisor.busy).toBe(false);
      expect(yield* f.request({ _tag: "Answer", name, question: q1, text: "late" })).toMatchObject({
        _tag: "Accepted",
        delivery: "followup",
      });
      expect(yield* Store.readQuestions(f.runDir)).toMatchObject([
        { _tag: "Asked" },
        { resolution: "cancelled", text: null },
        { resolution: "late", text: "late", delivery: "followup" },
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
            repeat: true,
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
        const result = yield* Effect.promise(() =>
          runCli(["steer", "unit", "change", "--json"], { env: { ...f.env, LOG_LEVEL: "none" } }),
        );
        expect(result.status).toBe(8);
        expect(result.stdout).toBe("");
        expect.soft(result.stderr).toContain("unit");
        expect.soft(result.stderr).toContain("wait");
        expect(result.stderr).not.toContain("should-not-escape");
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
        const firstWait = yield* f.wait();
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
        expect((yield* f.wait({ after: firstWait.cursor })).runs).toMatchObject([
          { kind: "interrupted", handoff: null },
        ]);
        expect(yield* f.cli(["wait", "unit", "--after", firstWait.cursor])).toContain(
          "No hand-off available.",
        );
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
        failure: hookSeen
          ? null
          : {
              message: expect.stringContaining(
                `repo hooks did not run in ${f.worktree}. Inspect ${f.repo}/.codex/hooks.json.`,
              ),
            },
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
