import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { CliError } from "effect/cli";
import { assert, describe, expect, it } from "vitest";
import { print } from "../src/commands/runs";
import { normalizeDurationArgs } from "../src/core/command-input";
import {
  BrokenPipe,
  Defect,
  ErrorEnvelope,
  errorClasses,
  errorEnvelope,
  exitCodeFor,
} from "../src/errors";
import { Method } from "../src/schemas/codex";
import { DaemonRequest } from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { successfulTurn } from "./fixtures/fake-app-server/scenarios";
import { ndjson, runCli, tempDir } from "./helpers/cli";
import { eventsFixture, eventsPlatform } from "./helpers/events";

it("documents monitor as a human view and status --all as the machine interface", async () => {
  const result = await runCli(["monitor", "--help"]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("status --all");
  expect(result.stdout).toContain("CODEX_DELEGATE");
  expect(result.stdout).toContain("130");
  expect(result.stdout.replace(/\s+/g, " ")).toContain(
    "normal status path and may start the daemon",
  );
});

it.each([false, true])("status rejects a name with --all (json=%s)", async (json) => {
  const result = await runCli(["status", "unit", "--all", ...(json ? ["--json"] : [])]);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Provide a run name or --all, not both.");
});

async function savedRun(home: string) {
  const dir = join(home, "runs", "unit");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      formatVersion: 1,
      name: "unit",
      threadId: null,
      group: "/repo",
      worktree: "/repo/work/unit",
      baseCommit: "base",
      model: "gpt-6.1-sol",
      effort: "high",
      tier: "priority",
      sandbox: "read-only",
      questionTimeoutMs: 900000,
      state: "idle",
      turns: 1,
      turnKind: "start",
      activeTurnId: null,
      turnBudgetMs: null,
      turnStartedAt: null,
      restoreSandbox: false,
      tokens: null,
      failure: null,
      warnings: [],
      createdAt: "2026-11-05T20:00:00.000Z",
      updatedAt: "2026-11-05T20:00:00.000Z",
    }),
  );
  return dir;
}

describe("events --follow", () => {
  it.each(["none", "events", "probe"])(
    "uses passive requests and drains remaining saved events on disconnect=%s",
    async (disconnect) => {
      const home = await tempDir();
      const events = [1, 2, 3].map((seq) => ({
        seq,
        at: "2026-11-05T20:00:00.000Z",
        event: { _tag: "AgentMessage", text: `message ${seq}`, phase: null },
      }));
      await savedRun(home);
      await writeFile(
        join(home, "runs", "unit", "events.jsonl"),
        `${events.map((event) => JSON.stringify({ ...event, formatVersion: 1 })).join("\n")}\n`,
      );
      const requests: (typeof DaemonRequest.Type)[] = [];
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          const request = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonRequest))(
            buffer.slice(0, end),
          );
          buffer = buffer.slice(end + 1);
          requests.push(request);
          const after = request.body._tag === "Events" ? (request.body.after ?? 0) : 0;
          if (
            (disconnect === "events" && request.body._tag === "Events" && after > 0) ||
            (disconnect === "probe" && request.body._tag === "Ping")
          ) {
            socket.destroy();
            return;
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              result:
                request.body._tag === "Ping"
                  ? { _tag: "Pong", version: "dev", pid: process.pid, build: "test" }
                  : {
                      _tag: "Events",
                      state: disconnect === "none" ? "idle" : "running",
                      gap: false,
                      next: Math.max(3, after),
                      events: events.filter(({ seq }) => seq > after),
                    },
            })}\n`,
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(home, "foreman.sock"), resolve);
      });
      try {
        const result = await runCli(["events", "unit", "--follow", "--limit", "1"], {
          home,
          env: { FOREMAN_HOME: home, LOG_LEVEL: "none" },
        });
        expect(result).toEqual({
          status: 0,
          stderr:
            disconnect !== "none"
              ? "No live daemon is supervising this run, so follow stopped (daemon connection lost). Run foreman status unit to start one.\n"
              : "",
          stdout: [1, 2, 3]
            .map((seq) => `${seq} 2026-11-05T20:00:00.000Z AgentMessage message ${seq}\n`)
            .join(""),
        });
        const cursors = disconnect === "none" ? [0, 1, 2, 3] : [0, 1];
        expect(requests).toEqual([
          { id: 1, passive: true, body: { _tag: "Ping" } },
          ...(disconnect === "probe" ? [] : cursors).map((after) => ({
            id: 1,
            passive: true,
            body: { _tag: "Events", name: "unit", after, waitMs: 15000 },
          })),
        ]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  it.each([
    { damage: "missing", code: 7, message: "No such run or question." },
    { damage: "corrupt", code: 8, message: "The request could not be completed." },
    { damage: "unsupported", code: 8, message: "The request could not be completed." },
    { damage: "record", code: 8, message: "The request could not be completed." },
    { damage: "permission", code: 6, message: "Permission denied. Check file permissions." },
  ])("reports actionable saved-data errors for $damage", async ({ damage, code, message }) => {
    const home = await tempDir();
    const dir = join(home, "runs", "unit");
    const file = join(dir, "events.jsonl");
    if (damage !== "missing") {
      await savedRun(home);
      await writeFile(file, damage === "unsupported" ? '{"formatVersion":999}\n' : "not json\n");
      if (damage === "record") {
        await writeFile(join(dir, "run.json"), "{}");
        await writeFile(file, "");
      }
      if (damage === "permission") await chmod(file, 0o000);
    }
    try {
      const result = await runCli(["events", "unit", "--follow"], {
        home,
        env: { FOREMAN_HOME: home, LOG_LEVEL: "none" },
        executable: ["/does-not-exist/foreman"],
      });
      expect(result.status).toBe(code);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain(dir);
      expect(result.stderr).toContain("retry");
      expect(result.stderr).not.toContain("Internal error");
      expect(result.stderr).not.toContain("follow stopped");
    } finally {
      if (damage === "permission") await chmod(file, 0o600);
    }
  });

  it("streams ordered events before completion and exits after draining every page", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const script = successfulTurn();
        const f = yield* eventsFixture({
          ...script,
          rules: script.rules
            .map((rule) =>
              rule.method === Method.turnStart
                ? {
                    ...rule,
                    steps: rule.steps?.flatMap((step) =>
                      "notify" in step && step.notify === Method.turnCompleted
                        ? [{ awaitRequest: Method.turnSteer }, step]
                        : [step],
                    ),
                  }
                : rule,
            )
            .concat({ method: Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } }),
        });
        let stdout = "";
        const pending = yield* Effect.promise((signal) =>
          runCli(["events", "unit", "--follow", "--limit", "1"], {
            env: f.env,
            home: f.root,
            signal,
            stdout: async (text) => {
              stdout += text;
            },
          }),
        ).pipe(Effect.forkChild);
        while (!stdout.includes("AgentMessage Created result.txt.")) yield* Effect.yieldNow;
        yield* f.untilState("running");
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* f.request({ _tag: "Steer", name: f.name, message: "Finish" });
        expect(yield* Fiber.join(pending)).toEqual({ status: 0, stdout: "", stderr: "" });
        const page = yield* f.request({ _tag: "Events", name: f.name });
        assert(page._tag === "Events");
        const lines = stdout.trimEnd().split("\n");
        expect(lines.map((line) => Number(line.split(" ")[0]))).toEqual(
          page.events
            .filter(({ event }) => event._tag !== "Other" && event._tag !== "TokenUsage")
            .map(({ seq }) => seq),
        );
        expect(stdout).toContain("TurnCompleted");
        expect(stdout).not.toContain("next:");
        expect(stdout).not.toContain("\u001b");
      }).pipe(Effect.timeout("10 seconds"), Effect.scoped, Effect.provide(eventsPlatform)),
    );
  });

  it("drains an already idle run from --after in bounded verbose pages without waiting", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* eventsFixture(successfulTurn());
        yield* f.untilState("idle");
        const result = yield* Effect.promise((signal) =>
          runCli(["events", "unit", "--follow", "--after", "2", "--limit", "1", "--verbose"], {
            env: f.env,
            home: f.root,
            signal,
          }),
        ).pipe(Effect.timeout("3 seconds"));
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
        const page = yield* f.request({ _tag: "Events", name: f.name, after: 2 });
        assert(page._tag === "Events");
        expect(
          result.stdout
            .trimEnd()
            .split("\n")
            .map((line) => Number(line.split(" ")[0])),
        ).toEqual(page.events.map(({ seq }) => seq));
        expect(result.stdout).toContain("TokenUsage");
        expect(result.stdout).not.toContain("next:");
      }).pipe(Effect.timeout("10 seconds"), Effect.scoped, Effect.provide(eventsPlatform)),
    );
  });

  it("rejects --follow --json as text-only before contacting the daemon", async () => {
    const result = await runCli(["events", "unit", "--follow", "--json"], {
      env: { LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(ndjson(result.stderr)).toEqual([
      {
        error: {
          tag: "Usage",
          message: "Invalid command. Run --help for usage.",
          detail: "--follow is text-only; omit --json.",
          retryable: false,
        },
      },
    ]);
  });

  it.each([
    { mode: "absent", reason: "no daemon running" },
    { mode: "outdated", reason: "daemon is outdated" },
    { mode: "unsupported", reason: "daemon does not support live events" },
  ])(
    "drains saved events and stops without starting or replacing a $mode daemon",
    async ({ mode, reason }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const f = yield* eventsFixture(
            successfulTurn(),
            mode === "unsupported",
            mode === "outdated" ? "old" : "test",
          );
          yield* f.untilState("idle");
          const page = yield* f.request({ _tag: "Events", name: f.name, after: 2 });
          assert(page._tag === "Events");
          if (mode === "absent") {
            yield* f.request({ _tag: "Shutdown" });
            const fs = yield* FileSystem.FileSystem;
            while (yield* fs.exists(`${f.env.FOREMAN_HOME}/foreman.sock`)) yield* Effect.yieldNow;
          }
          const result = yield* Effect.promise((signal) =>
            runCli(["events", "unit", "--follow", "--after", "2", "--limit", "1", "--verbose"], {
              env: f.env,
              home: f.root,
              signal,
              executable: ["/does-not-exist/foreman"],
            }),
          ).pipe(Effect.timeout("3 seconds"));
          expect(result.status).toBe(0);
          expect(
            result.stdout
              .trimEnd()
              .split("\n")
              .map((line) => Number(line.split(" ")[0])),
          ).toEqual(page.events.map(({ seq }) => seq));
          expect(result.stderr).toBe(
            `No live daemon is supervising this run, so follow stopped (${reason}). Run foreman status unit to start one.\n`,
          );
          const fs = yield* FileSystem.FileSystem;
          if (mode === "absent")
            expect(yield* fs.exists(`${f.env.FOREMAN_HOME}/foreman.sock`)).toBe(false);
          else expect((yield* f.request({ _tag: "Ping" }))._tag).toBe("Pong");
        }).pipe(Effect.timeout("10 seconds"), Effect.scoped, Effect.provide(eventsPlatform)),
      );
    },
  );
});

describe("stdout and error contracts", () => {
  it("review audit: daemon home creation permissions use exit 6", async () => {
    const home = await tempDir();
    const parent = join(home, "parent");
    await mkdir(parent);
    await chmod(parent, 0o500);
    try {
      const result = await runCli(["status", "--json"], {
        home,
        env: { FOREMAN_HOME: join(parent, "data"), LOG_LEVEL: "none" },
      });
      expect(result.status).toBe(6);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(parent);
      expect(result.stderr).toContain("permissions");
      expect(result.stderr).toContain("makeDirectory");
    } finally {
      await chmod(parent, 0o700);
    }
  });
  it("review audit: a failed final stderr write logs its cause to the file sink", async () => {
    const home = await tempDir();
    const log = join(home, "cli.jsonl");
    const result = await runCli(["unknown", "--json"], {
      home,
      env: { TEST_CLI_LOG_FILE: log },
      stderr: async () => {
        throw Object.assign(new TypeError("PRIVATE_STDERR"), { code: "EIO" });
      },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const logs = await readFile(log, "utf8");
    expect(logs).toContain("TypeError\\nat ");
    expect(logs).not.toContain("PRIVATE_STDERR");
  });
  it.each([
    new CliError.DuplicateOption({
      option: "json",
      parentCommand: "foreman",
      childCommand: "status",
    }),
    new CliError.UserError({
      cause: new TypeError("PRIVATE_CAUSE"),
      userMessage: "PRIVATE_MESSAGE",
    }),
  ])("keeps CLI implementation failures generic and logs their causes", async (error) => {
    const result = await runCli(["--json"], { program: Effect.fail(error) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(error.constructor.name);
    expect(result.stderr).not.toContain("PRIVATE_");
    expect(ndjson(result.stderr).at(-1)).toEqual(errorEnvelope(new Defect()));
  });
  it("keeps the cause of an impossible result encoding failure in the defect log", async () => {
    const result = await runCli(["--json"], {
      program: print(
        "events",
        Effect.succeed({ _tag: "Events", events: [], gap: false, next: NaN }),
      ),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SchemaError");
    expect(ndjson(result.stderr).at(-1)).toEqual(errorEnvelope(new Defect()));
  });
  it("names an unusable daemon socket path and its OS reason", async () => {
    const home = await tempDir();
    const data = join(home, "data");
    await writeFile(data, "file");
    const result = await runCli(["daemon", "stop", "--json"], {
      home,
      env: { FOREMAN_HOME: data, LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(data);
    expect(result.stderr).toContain("ENOTDIR");
    expect(result.stderr).toContain("Check");
  });
  it("reports a config path that is a directory as invalid configuration", async () => {
    const home = await tempDir();
    const data = join(home, "data");
    const file = join(data, "config.json");
    await mkdir(file, { recursive: true });
    const result = await runCli(["status", "--json"], {
      home,
      env: { FOREMAN_HOME: data, LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(file);
    expect(result.stderr).toContain("BadResource");
    expect(result.stderr).toContain("readable JSON file");
  });
  it("names an unusable daemon ownership database", async () => {
    const home = await tempDir();
    const data = join(home, "data");
    const lock = join(data, "daemon.guard.sqlite");
    await mkdir(lock, { recursive: true });
    const result = await runCli(["daemon", "--json"], {
      home,
      env: { FOREMAN_HOME: data, LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(lock);
    expect(result.stderr).toContain("permissions");
  });
  it("explains an oversized foreground daemon socket path", async () => {
    const home = await tempDir();
    const data = join(home, "é".repeat(55));
    const result = await runCli(["daemon", "--json"], {
      home,
      env: { FOREMAN_HOME: data, LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(data);
    expect(result.stderr).toContain("shorter");
    expect(result.stderr).toContain("FOREMAN_HOME");
  });
  it("names the daemon executable when spawning it fails", async () => {
    const home = await tempDir();
    const executable = join(home, "missing-foreman");
    const result = await runCli(["status", "--json"], {
      home,
      executable: [executable],
      env: { FOREMAN_HOME: join(home, "data"), LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(executable);
    expect(result.stderr).toContain("reinstall");
  });
  it("explains a missing daemon executable configuration", async () => {
    const home = await tempDir();
    const result = await runCli(["status", "--json"], {
      home,
      executable: [],
      env: { FOREMAN_HOME: join(home, "data"), LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No executable configured");
    expect(result.stderr).toContain("reinstall");
  });
  it("explains a daemon startup timeout without dispatching the command", async () => {
    const home = await tempDir();
    const data = join(home, "data");
    const result = await runCli(["status", "--json"], {
      home,
      env: { FOREMAN_HOME: data, LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(join(data, "foreman.sock"));
    expect(result.stderr).toContain("logs/daemon.jsonl");
    expect(result.stderr).toContain("not sent");
  }, 20000);
  it("normalizes negative duration values only before the argument delimiter", () => {
    const args = [
      "wait",
      "--timeout",
      "-1s",
      "--budget",
      "-2m",
      "--question-timeout",
      "-3s",
      "--",
      "--timeout",
      "-4s",
    ];
    expect(normalizeDurationArgs(args)).toEqual([
      "wait",
      "--timeout=-1s",
      "--budget=-2m",
      "--question-timeout=-3s",
      "--",
      "--timeout",
      "-4s",
    ]);
    expect(args[1]).toBe("--timeout");
  });
  it.each([
    { args: ["unknown"], subject: "unknown" },
    { args: ["doctor", "--unknown"], subject: "--unknown" },
    { args: ["events"], subject: "name" },
    { args: ["events", "unit", "--limit", "1", "--limit", "2"], subject: "--limit" },
  ])("identifies parser failures for $args", async ({ args, subject }) => {
    for (const json of [false, true]) {
      const result = await runCli([...args, ...(json ? ["--json"] : [])], {
        env: { LOG_LEVEL: "none" },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      const text = json ? JSON.parse(result.stderr).error.detail : result.stderr;
      expect(text).toContain(subject);
      expect(result.stderr).toContain("--help");
    }
  });
  it("redacts credential-shaped unexpected arguments in parser errors", async () => {
    const result = await runCli(["doctor", "sk-privatevalue", "--json"], {
      env: { LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[redacted]");
    expect(result.stderr).not.toContain("sk-privatevalue");
  });
  it.each([
    {
      args: ["start", "job", "--contract", "task"],
      detail: "Choose either --worktree or --new-worktree.",
    },
    {
      args: ["start", "job", "--contract", "task", "--worktree", ".", "--new-worktree"],
      detail: "Choose either --worktree or --new-worktree.",
    },
    {
      args: ["start", "job", "--contract", "task", "--worktree", ".", "--from", "main"],
      detail: "--from requires --new-worktree.",
    },
    {
      args: ["start", "job", "--contract", "task", "--worktree", ".", "--setup", "true"],
      detail: "--setup requires --new-worktree.",
    },
    { args: ["followup", "job"], detail: "Provide a message argument or --file." },
    {
      args: ["followup", "job", "hello", "--file", "message.txt"],
      detail: "Provide either a message argument or --file, not both.",
    },
  ])("explains conflicting or missing inputs: $args", async ({ args, detail }) => {
    for (const json of [false, true]) {
      const result = await runCli([...args, ...(json ? ["--json"] : [])], {
        env: { LOG_LEVEL: "none" },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      if (json)
        expect(JSON.parse(result.stderr)).toMatchObject({ error: { tag: "Usage", detail } });
      else expect(result.stderr).toContain(detail);
    }
  });
  it.each([
    [],
    ["start"],
    ["status"],
    ["events"],
    ["steer"],
    ["followup"],
    ["interrupt"],
    ["answer"],
    ["defer"],
    ["result"],
    ["archive"],
    ["wait"],
    ["doctor"],
    ["daemon"],
    ["daemon", "stop"],
  ])("describes every flag in help for %j", async (...command) => {
    const result = await runCli([...command, "--help"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    if (command[0] === "defer") expect(result.stdout).toContain("Release a pending question");
    const flags = result.stdout.split("\n").filter((line) => /^ {2}--/.test(line));
    expect(flags.length).toBeGreaterThan(0);
    for (const line of flags) expect(line.trim().split(/\s{2,}/).length, line).toBe(2);
  });
  it("lists the run commands and the daemon command", async () => {
    const result = await runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of [
      "start",
      "status",
      "events",
      "steer",
      "followup",
      "interrupt",
      "answer",
      "defer",
      "result",
      "archive",
      "wait",
      "doctor",
      "daemon",
    ])
      expect(result.stdout).toMatch(new RegExp(`\\b${command}\\b`));
  });
  it.each([
    { flags: ["--json=true"], json: true },
    { flags: ["--json", "false"], json: false },
    { flags: ["--json=false"], json: false },
    { flags: ["--json", "yes"], json: true },
    { flags: ["--no-json"], json: false },
  ])("uses the parsed boolean audience $flags", async ({ flags, json }) => {
    for (const command of ["doctor", "absent"]) {
      const result = await runCli([command, ...flags], { env: { LOG_LEVEL: "none" } });
      expect(result.status).toBe(command === "doctor" ? 0 : 2);
      if (command === "doctor") {
        expect(result.stderr).toBe("");
        if (json)
          expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout))).toMatchObject({
            codexBin: expect.stringContaining("missing-codex"),
          });
        else expect(result.stdout).toContain("Codex executable:");
      } else {
        expect(result.stdout).toBe("");
        if (json) expect(JSON.parse(result.stderr)).toMatchObject({ error: { tag: "Usage" } });
        else expect(result.stderr).toBe('Unknown command "absent".\nRun --help for usage.\n');
      }
    }
  });

  it.each([
    { flags: ["-v"], key: "version" },
    { flags: ["--version", "--help"], key: "help" },
    { flags: ["--version", "false", "--help"], key: "help" },
  ])("renders the framework action actually selected $flags", async ({ flags, key }) => {
    const result = await runCli(["--json", ...flags], { env: { LOG_LEVEL: "none" } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Object.keys(JSON.parse(result.stdout))).toEqual([key]);
  });

  it("rejects the unsupported built-in log-level flag", async () => {
    const result = await runCli(["doctor", "--log-level", "none", "--json"], {
      env: { LOG_LEVEL: "none" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { tag: "Usage" } });
  });
  it.each(
    [[], ["--help"], ["--version"], ["--json", "--help"], ["--json", "--version"]].map((args) => ({
      args,
    })),
  )("help and version survive broken config %j", async ({ args }) => {
    const home = await tempDir();
    const dir = join(home, ".foreman");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "broken");
    const result = await runCli(args, { home, env: { LOG_LEVEL: "none" } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001b");
    if (args.includes("--json"))
      expect(JSON.parse(result.stdout)).toHaveProperty(
        args.includes("--version") ? "version" : "help",
      );
    else expect(result.stdout).toContain(args.includes("--version") ? "dev" : "doctor");
  });

  it("renders the same diagnostic in human and JSON modes", async () => {
    const human = await runCli(["doctor"], { env: { LOG_LEVEL: "none" } });
    expect(human.status).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Codex executable:");
    const json = await runCli(["doctor", "--json"], { env: { LOG_LEVEL: "none" } });
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(json.stdout))).toMatchObject({
      codexBin: expect.stringContaining("missing-codex"),
      configError: null,
    });
  });

  it.each([["unknown"], ["doctor", "--unknown"], ["doctor", "extra"]].map((args) => ({ args })))(
    "usage failures keep stdout empty %j",
    async ({ args }) => {
      for (const json of [false, true]) {
        const result = await runCli([...args, ...(json ? ["--json"] : [])], {
          env: { LOG_LEVEL: "none" },
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        if (json)
          expect(Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr))).toMatchObject({
            error: { tag: "Usage", retryable: false },
          });
        else {
          let detail = 'Unexpected positional argument: "extra"';
          if (args[0] === "unknown") detail = 'Unknown command "unknown".';
          if (args[1] === "--unknown")
            detail = "Unrecognized flag: --unknown in command test-cli doctor";
          // What was wrong comes first; the pointer to help comes last.
          expect(result.stderr).toBe(`${detail}\nRun --help for usage.\n`);
        }
      }
    },
  );

  for (const Class of errorClasses)
    it(`renders ${new Class()._tag} through the real boundary`, async () => {
      const error = new Class();
      const result = await runCli(["--json"], {
        program: Effect.fail(error),
        env: { LOG_LEVEL: "none" },
      });
      expect(result.status).toBe(exitCodeFor(error));
      expect(result.stdout).toBe("");
      if (error instanceof BrokenPipe) expect(result.stderr).toBe("");
      else expect(JSON.parse(result.stderr)).toEqual(errorEnvelope(error));
    });

  it("a defect logs once without exposing its private message", async () => {
    const result = await runCli(["--json"], {
      program: Effect.die(new TypeError("PRIVATE_SENTINEL")),
      env: { LOG_LEVEL: "debug" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const records = ndjson(result.stderr);
    expect(
      records.filter((value) => JSON.stringify(value).includes('"msg":"defect"')),
    ).toHaveLength(1);
    expect(records[0]).toMatchObject({ trace: expect.stringContaining("TypeError\nat ") });
    expect(records.at(-1)).toMatchObject({ error: { tag: "Defect" } });
    expect(result.stderr).not.toContain("PRIVATE_SENTINEL");
  });

  it("quietly accepts a closed output pipe", async () => {
    const result = await runCli(["doctor"], {
      stdout: async () => {
        throw Object.assign(new Error("closed"), { code: "EPIPE" });
      },
    });
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
  });
  it.each(["EACCES", "EIO"])(
    "reports a %s stdout failure with its subject and correct category",
    async (code) => {
      const result = await runCli(["--version", "--json"], {
        stdout: async () => {
          throw Object.assign(new TypeError("PRIVATE_WRITE"), { code });
        },
      });
      expect(result.status).toBe(code === "EACCES" ? 6 : 1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("PRIVATE_WRITE");
      const envelope = ndjson(result.stderr).at(-1);
      if (code === "EACCES") {
        expect(envelope).toMatchObject({
          error: { tag: "PermissionDenied", detail: expect.stringContaining("stdout") },
        });
        expect(result.stderr).toContain("destination");
      } else {
        expect(envelope).toEqual(errorEnvelope(new Defect()));
        expect(result.stderr).toContain("TypeError\\nat ");
      }
    },
  );

  it("quietly accepts a closed error pipe", async () => {
    const result = await runCli(["absent", "--json"], {
      env: { LOG_LEVEL: "none" },
      stderr: async () => {
        throw Object.assign(new Error("closed"), { code: "EPIPE" });
      },
    });
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});
