import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { NodeServices, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";
import { allowedPaths } from "../src/core/runs/worktree";
import { call } from "../src/daemon/client";
import { daemon } from "../src/daemon/server";
import { DaemonSockets } from "../src/daemon/sockets";
import { type AppError, errorEnvelope, PermissionDenied, RunConflict, Usage } from "../src/errors";
import {
  Cursor,
  type DaemonRequestBody,
  DaemonResult,
  Digest,
  RunEvent,
  RunName,
} from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { Host } from "../src/services/host";
import { ndjson, runCli } from "./helpers/cli";

const name = Schema.decodeUnknownSync(RunName)("unit-a");
const cursor = Schema.decodeUnknownSync(Cursor)("opaque:42");
const digest = Schema.decodeUnknownSync(Digest)({
  name,
  state: "waiting",
  elapsedMs: 123000,
  model: "gpt-6.1-sol",
  effort: "high",
  tier: "priority",
  sandbox: "read-only",
  runDir: "/tmp/runs/unit-a",
  worktree: "/tmp/worktree",
  turn: 2,
  turnKind: "followup",
  questions: [{ id: "q2", kind: "blocked", question: "Which API?", pendingMs: 70000 }],
  commands: {
    total: 3,
    failed: 1,
    blockedByHooks: 0,
    last: { command: "bun run lint", exitCode: 1 },
  },
  filesWritten: ["src/cli.ts"],
  outsideMayChange: [],
  newInGitStatus: [],
  tokens: null,
  failure: null,
  warnings: ["protocol mismatch"],
});
const event = Schema.decodeUnknownSync(RunEvent)({
  seq: 7,
  at: "2026-11-05T20:00:00.000Z",
  event: { _tag: "AgentMessage", text: "first\nsecond", phase: null },
});

async function fixture(
  response: DaemonResult | AppError | ((body: DaemonRequestBody) => DaemonResult) = { _tag: "Ok" },
  build = "test",
) {
  const dataDir = await mkdtemp("/tmp/fm-u6-");
  await symlink(process.execPath, join(dataDir, "forman"));
  const requests: DaemonRequestBody[] = [];
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      NodeServices.layer,
      DaemonSockets.layer({
        connect: (path) => NodeSocket.makeNet({ path }),
        listen: (path) => NodeSocketServer.make({ path }),
      }),
      Host.layer({
        name: "forman",
        version: "test",
        build,
        platform: "node",
        compiled: false,
        executable: [process.execPath],
        pid: process.pid,
      }),
    ),
  );
  const fiber = runtime.runFork(
    daemon({
      dataDir,
      version: "daemon-test",
      busy: Effect.succeed(false),
      handler: (body) => {
        requests.push(body);
        if (build !== "test" && body._tag === "Shutdown")
          return Effect.fail(new RunConflict({ detail: "Active old runs" }));
        if (response instanceof Error) return Effect.fail(response);
        return Effect.succeed(typeof response === "function" ? response(body) : response);
      },
    }),
  );
  onTestFinished(async () => {
    await runtime.runPromise(Fiber.interrupt(fiber));
    await runtime.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  await runtime.runPromise(
    Effect.raceFirst(
      Fiber.join(fiber),
      Effect.gen(function* () {
        while (true) {
          const ping = yield* Effect.result(call({ _tag: "Ping" }, { dataDir, connectOnly: true }));
          if (ping._tag === "Success") return;
          yield* Effect.yieldNow;
        }
      }),
    ).pipe(Effect.timeout("3 seconds")),
  );
  const run = (args: readonly string[], env: Record<string, string> = {}) =>
    runCli(args, {
      home: dataDir,
      env: { FORMAN_HOME: dataDir, PATH: dataDir, ...env },
    });
  return { dataDir, requests, run };
}

function machine(stdout: string) {
  const values = ndjson(stdout);
  expect(values).toHaveLength(1);
  return Schema.decodeUnknownSync(DaemonResult)(values[0]);
}

describe("command requests through the real parser and daemon", () => {
  it("review: refuses a managed start before sending it to an outdated busy daemon", async () => {
    const f = await fixture({ _tag: "Started", name, runDir: "/unsafe" }, "old");
    const contract = join(f.dataDir, "contract.md");
    await writeFile(contract, "Work");
    const result = await f.run([
      "start",
      name,
      "--new-worktree",
      "--setup",
      "true",
      "--contract",
      contract,
      "--json",
    ]);
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("managed worktrees");
    expect(f.requests.every((request) => request._tag !== "Start")).toBe(true);
  });
  it("accepts a one-call managed start and keeps its path and branch with --wait", async () => {
    const f = await fixture((body) =>
      body._tag === "Wait"
        ? {
            _tag: "Waited",
            outcome: "timeout",
            runs: [],
            cursor,
            next: "forman wait unit-a --after opaque:42",
          }
        : {
            _tag: "Started",
            name,
            runDir: f.dataDir,
            worktree: "/repo/.claude/worktrees/unit-a",
            branch: "forman/unit-a",
          },
    );
    const contract = join(f.dataDir, "contract.md");
    await writeFile(contract, "Work");
    const result = await f.run([
      "start",
      name,
      "--new-worktree",
      "--from",
      "main",
      "--setup",
      "bun install",
      "--contract",
      contract,
      "--write",
      "--wait",
      "--json",
    ]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(machine(result.stdout)).toMatchObject({
      started: { worktree: "/repo/.claude/worktrees/unit-a", branch: "forman/unit-a" },
    });
    expect(f.requests[0]).toMatchObject({
      _tag: "Start",
      newWorktree: true,
      from: "main",
      setup: "bun install",
      worktree: await realpath("."),
    });
    expect((await f.run(["archive", name, "--keep-worktree"])).status).toBe(0);
    expect(f.requests.at(-1)).toMatchObject({ _tag: "Archive", keepWorktree: true });
  });
  it.each(
    [
      ["--new-worktree", "--worktree", "."],
      ["--worktree", ".", "--setup", "true"],
      ["--worktree", ".", "--from", "main"],
      [],
    ].map((flags) => ({ flags })),
  )("refuses conflicting or incomplete worktree flags: $flags", async ({ flags }) => {
    const f = await fixture();
    const result = await f.run(["start", name, ...flags, "--contract", "unused", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(f.requests).toEqual([]);
  });
  it.each(["answer", "steer", "followup", "interrupt"])(
    "prints and waits on the combined continuation for %s",
    async (command) => {
      const f = await fixture((body) =>
        body._tag === "Wait"
          ? {
              _tag: "Waited",
              outcome: "timeout",
              runs: [],
              cursor,
              next: "forman wait --all --after opaque:42",
            }
          : { _tag: "Accepted", all: true, cursor },
      );
      const messages: Record<string, string[]> = {
        answer: ["q1", "Proceed"],
        interrupt: [],
        steer: ["Continue"],
        followup: ["Continue"],
      };
      const args = [command, name, ...(messages[command] ?? [])];
      const human = await f.run(args);
      expect(human).toMatchObject({
        status: 0,
        stdout: `ok\nnext: FORMAN_HOME=${f.dataDir} forman wait --all --after opaque:42\n`,
        stderr: "",
      });
      const json = await f.run([...args, "--json"]);
      expect(machine(json.stdout)).toMatchObject({
        next: `FORMAN_HOME=${f.dataDir} forman wait --all --after opaque:42`,
      });
      expect((await f.run([...args, "--wait", "--timeout", "0ms"])).status).toBe(0);
      expect(f.requests.at(-1)).toMatchObject({
        _tag: "Wait",
        all: true,
        names: [],
        after: cursor,
      });
    },
  );
  it.each([false, true])(
    "merge: interrupt adapts an older busy daemon's Ok, wait=%s",
    async (waiting) => {
      const f = await fixture(
        (body) =>
          body._tag === "Wait"
            ? {
                _tag: "Waited",
                outcome: "timeout",
                runs: [],
                cursor,
                next: "forman wait unit-a --after opaque:42",
              }
            : { _tag: "Ok" },
        "old",
      );
      const result = await f.run([
        "interrupt",
        "unit-a",
        ...(waiting ? ["--wait", "--timeout", "90s"] : []),
        "--json",
      ]);
      expect(result.status).toBe(0);
      expect(machine(result.stdout)).toMatchObject(
        waiting
          ? { _tag: "Waited" }
          : {
              _tag: "Accepted",
              cursor,
              next: `FORMAN_HOME=${f.dataDir} forman wait unit-a --after opaque:42`,
            },
      );
      expect(f.requests.map((body) => body._tag)).toEqual(
        waiting
          ? ["Shutdown", "Wait", "Interrupt", "Shutdown", "Wait"]
          : ["Shutdown", "Wait", "Interrupt"],
      );
    },
  );
  it.each([false, true])("interrupt returns a continuation, wait=%s", async (waiting) => {
    const f = await fixture((body) =>
      body._tag === "Wait"
        ? {
            _tag: "Waited",
            outcome: "timeout",
            runs: [],
            cursor,
            next: "forman wait unit-a --after opaque:42",
          }
        : { _tag: "Accepted", cursor },
    );
    const result = await f.run([
      "interrupt",
      "unit-a",
      ...(waiting ? ["--wait", "--timeout", "90s"] : []),
      "--json",
    ]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(machine(result.stdout)).toMatchObject(
      waiting
        ? { _tag: "Waited" }
        : {
            _tag: "Accepted",
            cursor,
            next: `FORMAN_HOME=${f.dataDir} forman wait unit-a --after opaque:42`,
          },
    );
    expect(f.requests[0]).toEqual({ _tag: "Interrupt", name });
    if (waiting)
      expect(f.requests[1]).toMatchObject({ _tag: "Wait", after: cursor, timeoutMs: 90000 });
  });
  it.each(["answer", "followup", "steer"])(
    "refuses %s before dispatch when an outdated busy daemon cannot provide a cursor",
    async (command) => {
      const f = await fixture({ _tag: "Ok" }, "old");
      const result = await f.run(
        [command, "unit-a", ...(command === "answer" ? ["q2"] : []), "Proceed", "--wait", "--json"],
        { LOG_LEVEL: "none" },
      );
      expect(result.status).toBe(4);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr.trimEnd().split("\n").at(-1) ?? "")).toMatchObject({
        error: {
          tag: "DaemonUnavailable",
          detail: expect.stringContaining("request was not sent"),
        },
      });
      expect(f.requests.map((body) => body._tag)).toEqual(["Shutdown", "Wait"]);
    },
  );

  it("prefers a busy different build's accepted cursor over its compatibility probe", async () => {
    const accepted = Schema.decodeUnknownSync(Cursor)("accepted:99");
    const f = await fixture(
      (body) =>
        body._tag === "Wait"
          ? {
              _tag: "Waited",
              outcome: "timeout",
              runs: [],
              cursor,
              next: "forman wait unit-a --after opaque:42",
            }
          : { _tag: "Accepted", cursor: accepted },
      "different",
    );
    const result = await f.run(["answer", "unit-a", "q2", "Proceed", "--json"]);
    expect(result.status).toBe(0);
    expect(machine(result.stdout)).toEqual({
      _tag: "Accepted",
      cursor: accepted,
      next: `FORMAN_HOME=${f.dataDir} forman wait unit-a --after accepted:99`,
    });
    expect(f.requests.map((body) => body._tag)).toEqual(["Shutdown", "Wait", "Answer"]);
  });

  for (const command of ["start", "answer", "followup", "steer"] as const) {
    it.each([undefined, "90s"])(
      `${command} --wait uses timeout %s and the accepted cursor`,
      async (timeout) => {
        const f = await fixture((body) => {
          if (body._tag === "Wait")
            return {
              _tag: "Waited",
              outcome: "timeout",
              runs: [],
              cursor,
              next: "forman wait unit-a --after opaque:42",
            };
          return command === "start"
            ? { _tag: "Started", name, runDir: "/runs/unit-a" }
            : { _tag: "Accepted", cursor };
        });
        const args =
          command === "start"
            ? [command, "unit-a", "--worktree", ".", "--contract", "README.md"]
            : [command, "unit-a", ...(command === "answer" ? ["q2"] : []), "Proceed"];
        const result = await f.run([
          ...args,
          "--wait",
          ...(timeout ? ["--timeout", timeout] : []),
          "--json",
        ]);
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(machine(result.stdout)).toMatchObject({ _tag: "Waited", outcome: "timeout" });
        expect(f.requests).toHaveLength(2);
        expect(f.requests[1]).toEqual({
          _tag: "Wait",
          names: [name],
          all: false,
          cwd: await realpath(process.cwd()),
          timeoutMs: timeout ? 90000 : 3600000,
          ...(command === "start" ? {} : { after: cursor }),
        });
      },
    );
  }
  it.each([false, true])("stops the daemon through the parser, json=%s", async (json) => {
    const f = await fixture();
    const result = await f.run(["daemon", "stop", ...(json ? ["--json"] : [])]);
    expect(result).toEqual({
      status: 0,
      stdout: json ? '{"_tag":"Ok"}\n' : "Daemon stopped.\n",
      stderr: "",
    });
    expect(f.requests).toEqual([{ _tag: "Shutdown" }]);
  });

  it("reports a shutdown refusal with its active run names", async () => {
    const f = await fixture(new RunConflict({ detail: "Active runs: unit-a, unit-b" }));
    const result = await f.run(["daemon", "stop", "--json"], { LOG_LEVEL: "none" });
    expect(result.status).toBe(8);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { tag: "RunConflict", detail: "Active runs: unit-a, unit-b" },
    });
  });

  it.each([false, true])("reports no daemon without starting one, json=%s", async (json) => {
    const dataDir = await mkdtemp("/tmp/fm-stop-");
    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
    const result = await runCli(["daemon", "stop", ...(json ? ["--json"] : [])], {
      home: dataDir,
      env: { FORMAN_HOME: dataDir },
    });
    expect(result).toEqual({
      status: 0,
      stdout: json ? '{"_tag":"Ok"}\n' : "Daemon: not running.\n",
      stderr: "",
    });
    await expect(readFile(join(dataDir, "forman.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dataDir, "daemon.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sends start overrides, real worktree paths and contract text", async () => {
    const f = await fixture();
    await writeFile(join(f.dataDir, "contract.md"), "Implement this.\n");
    await symlink(f.dataDir, join(f.dataDir, "linked"));
    const result = await f.run([
      "start",
      "unit-a",
      "--worktree",
      relative(process.cwd(), join(f.dataDir, "linked")),
      "--contract",
      relative(process.cwd(), join(f.dataDir, "linked", "contract.md")),
      "--write",
      "--model",
      "custom",
      "--effort",
      "high",
      "--tier",
      "priority",
      "--budget",
      "1h",
      "--question-timeout",
      "90s",
      "--skip-deps-check",
    ]);
    expect(result).toEqual({ status: 0, stdout: "ok\n", stderr: "" });
    expect(f.requests).toEqual([
      {
        _tag: "Start",
        name,
        worktree: await realpath(f.dataDir),
        contract: "Implement this.\n",
        write: true,
        model: "custom",
        effort: "high",
        tier: "priority",
        budgetMs: 3600000,
        questionTimeoutMs: 90000,
        skipDepsCheck: true,
      },
    ]);
  });

  it("leaves start defaults to the daemon", async () => {
    const f = await fixture();
    const contract = join(f.dataDir, "contract.md");
    await writeFile(contract, "contract");
    const result = await f.run([
      "start",
      "unit-a",
      "--worktree",
      f.dataDir,
      "--contract",
      contract,
    ]);
    expect(result).toEqual({ status: 0, stdout: "ok\n", stderr: "" });
    expect(f.requests).toEqual([
      {
        _tag: "Start",
        name,
        worktree: await realpath(f.dataDir),
        contract: "contract",
        write: false,
        skipDepsCheck: false,
      },
    ]);
  });

  it.each([
    { args: ["status"], body: { _tag: "Status" } },
    { args: ["status", "unit-a"], body: { _tag: "Status", name } },
    { args: ["events", "unit-a"], body: { _tag: "Events", name } },
    {
      args: ["events", "unit-a", "--after", "7", "--limit", "20"],
      body: { _tag: "Events", name, after: 7, limit: 20 },
    },
    {
      args: ["steer", "unit-a", "change direction"],
      body: { _tag: "Steer", name, message: "change direction" },
    },
    {
      args: ["followup", "unit-a", "continue"],
      body: { _tag: "Followup", name, message: "continue" },
    },
    {
      args: ["followup", "unit-a", "continue", "--budget", "45m", "--effort", "low"],
      body: { _tag: "Followup", name, message: "continue", budgetMs: 2700000, effort: "low" },
    },
    { args: ["interrupt", "unit-a"], body: { _tag: "Interrupt", name } },
    {
      args: ["answer", "unit-a", "q2", "use v4"],
      body: { _tag: "Answer", name, question: "q2", text: "use v4" },
    },
    { args: ["result", "unit-a"], body: { _tag: "Result", name } },
    { args: ["archive", "unit-a"], body: { _tag: "Archive", name } },
    { args: ["wait"], body: { _tag: "Wait", names: [], all: false, timeoutMs: 3600000 } },
    {
      args: ["wait", "unit-a", "unit-b", "--after", "opaque:42", "--timeout", "90s"],
      body: { _tag: "Wait", names: [name, "unit-b"], all: false, after: cursor, timeoutMs: 90000 },
    },
    {
      args: ["wait", "--all", "--timeout", "1ms"],
      body: { _tag: "Wait", names: [], all: true, timeoutMs: 1 },
    },
  ])("sends exactly one request for $args", async ({ args, body }) => {
    const f = await fixture();
    expect(await f.run([...args, "--json"])).toEqual({
      status: 0,
      stdout: '{"_tag":"Ok"}\n',
      stderr: "",
    });
    const cwd =
      body._tag === "Status" || body._tag === "Wait" ? { cwd: await realpath(process.cwd()) } : {};
    expect(f.requests).toEqual([{ ...body, ...cwd }]);
  });

  it.each(["steer", "followup", "answer"])(
    "reads %s text from a relative symlinked file",
    async (command) => {
      const f = await fixture();
      await writeFile(join(f.dataDir, "message"), "line 1\nline 2\n");
      await symlink(join(f.dataDir, "message"), join(f.dataDir, "link"));
      const args = [
        command,
        "unit-a",
        ...(command === "answer" ? ["q2"] : []),
        "--file",
        relative(process.cwd(), join(f.dataDir, "link")),
      ];
      expect(await f.run(args)).toEqual({ status: 0, stdout: "ok\n", stderr: "" });
      const tag = { answer: "Answer", steer: "Steer", followup: "Followup" }[command];
      expect(f.requests).toEqual([
        {
          _tag: tag,
          name,
          ...(command === "answer"
            ? { question: "q2", text: "line 1\nline 2\n" }
            : { message: "line 1\nline 2\n" }),
        },
      ]);
    },
  );

  it.each([
    ["start"],
    ["status", "Invalid"],
    ["events"],
    ["interrupt", "../escape"],
    ["result"],
    ["archive"],
    ["archive", "../escape"],
    ["start", "unit-a", "--worktree", ".", "--contract", "absent", "--budget", "tomorrow"],
    ["followup", "unit-a", "go", "--budget", "999999999999999999h"],
    ["wait", "Bad"],
    ["wait", "--timeout", "-1s"],
    ["wait", "--timeout", "1.5m"],
    ["wait", "--timeout", "1h\n"],
    ...["start", "answer", "followup", "steer"].map((command) => [
      command,
      "unit-a",
      ...(command === "start"
        ? ["--worktree", ".", "--contract", "README.md"]
        : [...(command === "answer" ? ["q2"] : []), "Proceed"]),
      "--wait",
      "--timeout",
      "tomorrow",
    ]),
    ["events", "unit-a", "--after", "-1"],
    ["events", "unit-a", "--limit", "0"],
    ["answer", "unit-a", "invalid", "yes"],
    ...["steer", "followup", "answer"].flatMap((command) => {
      const base = [command, "unit-a", ...(command === "answer" ? ["q1"] : [])];
      return [base, [...base, "message", "--file", "absent"]];
    }),
  ])("rejects invalid arguments before calling the daemon: %j", async (...args) => {
    const f = await fixture();
    const result = await f.run([...args, "--json"], { LOG_LEVEL: "none" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual(errorEnvelope(new Usage()));
    expect(f.requests).toEqual([]);
  });

  it.each(["worktree", "contract", "message"])(
    "names a missing %s input without dispatch",
    async (input) => {
      const f = await fixture();
      const missing = join(f.dataDir, "missing");
      const contract = join(f.dataDir, "contract.md");
      await writeFile(contract, "Do the work.");
      const args =
        input === "message"
          ? ["followup", "unit-a", "--file", missing]
          : [
              "start",
              "unit-a",
              "--worktree",
              input === "worktree" ? missing : f.dataDir,
              "--contract",
              input === "contract" ? missing : contract,
            ];
      const result = await f.run([...args, "--json"], { LOG_LEVEL: "none" });
      expect(result.status).toBe(9);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          tag: "WorktreeInvalid",
          detail: expect.stringContaining(missing),
          retryable: false,
        },
      });
      const human = await f.run(args, { LOG_LEVEL: "none" });
      expect(human.status).toBe(9);
      expect(human.stdout).toBe("");
      expect(human.stderr).toContain(missing);
      expect(human.stderr).toContain("Input not found:");
      expect(human.stderr).not.toContain("Permission denied");
      expect(f.requests).toEqual([]);
    },
  );

  it("maps an unreadable contract to PermissionDenied without a daemon request", async () => {
    const f = await fixture();
    const contract = join(f.dataDir, "private.md");
    await writeFile(contract, "private");
    await chmod(contract, 0);
    onTestFinished(() => chmod(contract, 0o600));
    const result = await f.run(
      ["start", "unit-a", "--worktree", f.dataDir, "--contract", contract, "--json"],
      { LOG_LEVEL: "none" },
    );
    expect(result).toEqual({
      status: 6,
      stdout: "",
      stderr: `${JSON.stringify(errorEnvelope(new PermissionDenied()))}\n`,
    });
    expect(f.requests).toEqual([]);
  });

  it("renders daemon AppErrors with their detail", async () => {
    const error = new RunConflict({ detail: "answer q2 first" });
    const f = await fixture(error);
    const json = await f.run(["steer", "unit-a", "go", "--json"], { LOG_LEVEL: "none" });
    expect(json).toEqual({
      status: 8,
      stdout: "",
      stderr: `${JSON.stringify(errorEnvelope(error))}\n`,
    });
    const human = await f.run(["steer", "unit-a", "go"], { LOG_LEVEL: "none" });
    expect(human.status).toBe(8);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("answer q2 first\n");
  });
});

const outputCases: { label: string; args: string[]; response: DaemonResult; text: string[] }[] = [
  {
    label: "archived",
    args: ["archive", "unit-a"],
    response: { _tag: "Archived", name, archivePath: "/tmp/runs/.archive/unit-a-123" },
    text: ["/tmp/runs/.archive/unit-a-123\n"],
  },
  {
    label: "pong",
    args: ["status"],
    response: { _tag: "Pong", version: "test", pid: 42 },
    text: ["running test (pid 42)\n"],
  },
  {
    label: "started",
    args: ["start", "unit-a", "--worktree", ".", "--contract", "README.md"],
    response: { _tag: "Started", name, runDir: "/tmp/runs/unit-a" },
    text: ["unit-a\n/tmp/runs/unit-a\nnext: forman wait unit-a\n"],
  },
  {
    label: "digests",
    args: ["status"],
    response: {
      _tag: "Digests",
      digests: [digest, { ...digest, name: Schema.decodeUnknownSync(RunName)("unit-b") }],
    },
    text: [
      "unit-a  waiting  turn 2 (followup)  2m03s  q2 pending\n",
      "unit-b  waiting  turn 2 (followup)  2m03s  q2 pending\n",
    ],
  },
  {
    label: "named digest",
    args: ["status", "unit-a"],
    response: { _tag: "Digests", digests: [digest] },
    text: ["run:       unit-a", "q2 (blocked)", "warning:   protocol mismatch"],
  },
  {
    label: "removed worktree summary",
    args: ["status"],
    response: {
      _tag: "Digests",
      digests: [{ ...digest, warnings: ["worktree removed: /tmp/worktree"] }],
    },
    text: ["unit-a  waiting  turn 2 (followup)  2m03s  q2 pending  worktree removed\n"],
  },
  {
    label: "empty digests",
    args: ["status"],
    response: { _tag: "Digests", digests: [] },
    text: ["no runs\n"],
  },
  {
    label: "events",
    args: ["events", "unit-a"],
    response: { _tag: "Events", events: [event], gap: true, next: 7 },
    text: [
      "gap: true\n7 2026-11-05T20:00:00.000Z AgentMessage first\\nsecond\nnext: forman events unit-a --after 7\n",
    ],
  },
  {
    label: "empty events",
    args: ["events", "unit-a"],
    response: { _tag: "Events", events: [], gap: false, next: 0 },
    text: ["next: forman events unit-a --after 0\n"],
  },
  { label: "ok", args: ["interrupt", "unit-a"], response: { _tag: "Ok" }, text: ["ok\n"] },
  {
    label: "result",
    args: ["result", "unit-a"],
    response: {
      _tag: "Result",
      digest,
      handoff: { turn: 1, text: "Built the CLI.\nTests pass." },
      latestTurnWithoutHandoff: true,
    },
    text: [
      "run:       unit-a",
      "Hand-off (turn 1):\nBuilt the CLI.\nTests pass.",
      "Latest turn (2) ended without a hand-off.",
    ],
  },
  {
    label: "no handoff",
    args: ["result", "unit-a"],
    response: { _tag: "Result", digest, handoff: null, latestTurnWithoutHandoff: false },
    text: ["No hand-off available."],
  },
  {
    label: "wait events",
    args: ["wait", "--all"],
    response: {
      _tag: "Waited",
      outcome: "events",
      cursor,
      next: "forman wait --all --after opaque:42",
      runs: [
        { name, kind: "question", summary: "q2 (blocked): Which API?", digest, handoff: null },
        ...(["done", "failed", "interrupted", "lost"] as const).map((kind) => ({
          name: Schema.decodeUnknownSync(RunName)(`unit-${kind}`),
          kind,
          summary: "turn 1",
          digest: { ...digest, name: Schema.decodeUnknownSync(RunName)(`unit-${kind}`) },
          handoff:
            kind === "done" || kind === "failed"
              ? { turn: 1, text: "The full hand-off.\nChecks." }
              : null,
        })),
      ],
    },
    text: [
      "question    unit-a q2 (blocked): Which API?\ndone        unit-done turn 1\nfailed      unit-failed turn 1\ninterrupted unit-interrupted turn 1\nlost        unit-lost turn 1",
      "q2 (blocked) pending 1m10s: Which API?",
      "run:       unit-lost",
      "Hand-off (turn 1):\nThe full hand-off.\nChecks.",
      "No hand-off available.",
      "cursor: opaque:42\nnext: forman wait --all --after opaque:42\n",
    ],
  },
  ...(["timeout", "none"] as const).map((outcome) => ({
    label: outcome,
    args: ["wait", "--all"],
    response: {
      _tag: "Waited" as const,
      outcome,
      runs: [],
      cursor,
      next: "forman wait --all --after opaque:42",
    },
    text: [`${outcome}\ncursor: opaque:42\nnext: forman wait --all --after opaque:42\n`],
  })),
];

describe("daemon result rendering", () => {
  it("parses the README example's doctor scope", async () => {
    const readme = await readFile("README.md", "utf8");
    const contract = readme.split("<<'CONTRACT'\n")[1]?.split("\nCONTRACT")[0];
    expect(contract).toBeDefined();
    expect(allowedPaths(contract ?? "")).toEqual(["src/commands/doctor.ts"]);
  });
  it("retains the absolute home when the caller supplies a relative FORMAN_HOME", async () => {
    const f = await fixture({ _tag: "Accepted", cursor });
    const result = await f.run(["interrupt", name, "--json"], {
      FORMAN_HOME: relative(process.cwd(), f.dataDir),
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(machine(result.stdout)).toMatchObject({
      next: `FORMAN_HOME=${f.dataDir} forman wait unit-a --after opaque:42`,
    });
  });
  it.each(["same", "different", "absent"] as const)(
    "prints usable next commands when forman on PATH is %s",
    async (target) => {
      const response = {
        _tag: "Waited",
        outcome: "timeout",
        runs: [],
        cursor,
        next: "forman wait --all --after opaque:42",
      } satisfies DaemonResult;
      const f = await fixture(response);
      const bin = join(f.dataDir, "bin");
      await mkdir(bin);
      if (target === "same") await symlink(process.execPath, join(bin, "forman"));
      if (target === "different")
        await writeFile(join(bin, "forman"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const executable = target === "same" ? "forman" : process.execPath;
      for (const json of [false, true]) {
        const result = await f.run(
          ["wait", "--all", "--timeout", "9m", ...(json ? ["--json"] : [])],
          { PATH: bin },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const next = `FORMAN_HOME=${f.dataDir} ${executable} wait --all --after opaque:42 --timeout 9m`;
        if (json) expect(machine(result.stdout)).toMatchObject({ next });
        else expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(`next: ${next}`);
      }
      const started = await fixture({ _tag: "Started", name, runDir: "/runs/unit-a" });
      const result = await started.run(
        ["start", "unit-a", "--worktree", ".", "--contract", "README.md"],
        { PATH: bin },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
        `next: FORMAN_HOME=${started.dataDir} ${executable} wait unit-a`,
      );
      for (const command of ["answer", "followup", "steer"]) {
        const accepted = await fixture({ _tag: "Accepted", cursor });
        for (const json of [false, true]) {
          const result = await accepted.run(
            [
              command,
              "unit-a",
              ...(command === "answer" ? ["q2"] : []),
              "Proceed",
              ...(json ? ["--json"] : []),
            ],
            { PATH: bin },
          );
          expect(result).toMatchObject({ status: 0, stderr: "" });
          const next = `FORMAN_HOME=${accepted.dataDir} ${executable} wait unit-a --after opaque:42`;
          if (json)
            expect(machine(result.stdout)).toMatchObject({ _tag: "Accepted", cursor, next });
          else expect(result.stdout).toBe(`ok\nnext: ${next}\n`);
        }
      }
    },
  );
  it.each(outputCases)(
    "renders $label in text and one schema-encoded JSON value",
    async ({ args, response, text }) => {
      const f = await fixture(response);
      const human = await f.run(args);
      expect(human.status).toBe(0);
      expect(human.stderr).toBe("");
      for (const part of text)
        expect(human.stdout).toContain(
          part.replaceAll("next: forman", `next: FORMAN_HOME=${f.dataDir} forman`),
        );
      if (response._tag === "Waited") {
        expect(human.stdout).not.toContain("\n\n\n");
        expect(human.stdout.trimEnd().split("\n").at(-1)).toBe(
          `next: FORMAN_HOME=${f.dataDir} ${response.next}`,
        );
      }
      if (response._tag === "Started")
        expect(human.stdout.trimEnd().split("\n").at(-1)).toBe(
          `next: FORMAN_HOME=${f.dataDir} forman wait unit-a`,
        );
      if (response._tag === "Digests" && args.length === 1) {
        expect(human.stdout.trimEnd().split("\n")).toHaveLength(
          Math.max(1, response.digests.length),
        );
      }
      const json = await f.run([...args, "--json"]);
      expect(json.status).toBe(0);
      expect(json.stderr).toBe("");
      expect(machine(json.stdout)).toEqual(
        response._tag === "Waited"
          ? { ...response, next: `FORMAN_HOME=${f.dataDir} ${response.next}` }
          : response,
      );
    },
  );
});

describe("doctor diagnostics", () => {
  it("reports an absent daemon and missing Codex without starting anything", async () => {
    const home = await mkdtemp("/tmp/fm-doc-");
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const result = await runCli(["doctor", "--json"], {
      home,
      env: { FORMAN_HOME: home, CODEX_BIN: join(home, "missing") },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout))).toMatchObject({
      codexVersion: null,
      protocolMatches: null,
      loggedIn: null,
      daemon: { state: "not running" },
    });
    await expect(readFile(join(home, "forman.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, "daemon.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports the running daemon's version and pid", async () => {
    const f = await fixture();
    const json = await f.run(["doctor", "--json"]);
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toMatchObject({
      daemon: { state: "running", version: "daemon-test", pid: process.pid },
    });
    const human = await f.run(["doctor"]);
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain(`Daemon: running daemon-test (pid ${process.pid})`);
    expect(f.requests).toEqual([]);
  });

  it.each([0, 1])(
    "checks Codex version, protocol hash and login exit %s without printing login output",
    async (code) => {
      const f = await fixture();
      const bin = join(f.dataDir, "codex");
      await writeFile(
        bin,
        `#!/bin/sh\ncase "$1" in\n  --version) echo 'codex-cli 0.166.0';;\n  app-server) echo '{}' > "$5/schema.json";;\n  login) echo PRIVATE_LOGIN; echo PRIVATE_LOGIN >&2; exit ${code};;\nesac\n`,
        { mode: 0o755 },
      );
      const result = await f.run(["doctor", "--json"], { CODEX_BIN: bin });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        codexVersion: "0.166.0",
        protocolMatches: false,
        loggedIn: code === 0,
      });
      expect(result.stdout).not.toContain("PRIVATE_LOGIN");
    },
  );
});
