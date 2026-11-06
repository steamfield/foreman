import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { CliError } from "effect/cli";
import { describe, expect, it } from "vitest";
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
import { DoctorResult } from "../src/schemas/doctor";
import { ndjson, runCli, tempDir } from "./helpers/cli";

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
        else
          expect(result.stderr).toBe(
            'Invalid command. Run --help for usage.\nUnknown subcommand "absent" for "test-cli"\n',
          );
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
          if (args[0] === "unknown") detail = 'Unknown subcommand "unknown" for "test-cli"';
          if (args[1] === "--unknown")
            detail = "Unrecognized flag: --unknown in command test-cli doctor";
          expect(result.stderr).toBe(`Invalid command. Run --help for usage.\n${detail}\n`);
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
