import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config";
import { DoctorResult } from "../src/schemas/doctor";
import { Output } from "../src/services/output";
import { ndjson, runCli, tempDir } from "./helpers/cli";

async function configFile(content: string) {
  const home = await tempDir();
  const dir = join(home, ".foreman");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), content);
  return home;
}

describe("real config and emitted logging", () => {
  it.each([undefined, "", " \t ", "./npm/foreman.cjs"])(
    "resolves launcher identity only from FOREMAN_LAUNCHER=%j",
    async (launcher) => {
      const result = await runCli(["--json"], {
        env: { FOREMAN_LAUNCHER: launcher },
        program: Effect.gen(function* () {
          yield* (yield* Output).result((yield* AppConfig).launcher, "launcher");
        }),
      });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toBe(launcher?.trim() ? resolve(launcher) : null);
    },
  );
  it("replaces an oversized CLI log record with a bounded omission record", async () => {
    const home = await tempDir();
    const log = join(home, "cli.jsonl");
    const result = await runCli(["--json"], {
      home,
      env: { TEST_CLI_LOG_FILE: log },
      program: Effect.logError("x".repeat(5_000_001)),
    });
    expect(result.status).toBe(0);
    const text = await readFile(log, "utf8");
    expect(text.length).toBeLessThan(1000);
    expect(ndjson(text)).toContainEqual(expect.objectContaining({ msg: "log.record.omitted" }));
  });
  it("rotates a full CLI file sink while preserving the current command record", async () => {
    const home = await tempDir();
    const log = join(home, "cli.jsonl");
    await writeFile(log, "x".repeat(5_000_001));
    const result = await runCli(["absent", "--json"], { home, env: { TEST_CLI_LOG_FILE: log } });
    expect(result.status).toBe(2);
    expect((await readFile(`${log}.1`, "utf8")).length).toBe(5_000_001);
    expect(ndjson(await readFile(log, "utf8"))).toContainEqual(
      expect.objectContaining({ msg: "command" }),
    );
  });
  it.each([undefined, "", " ", "absolute", "relative"])(
    "uses FOREMAN_HOME=%s for configuration and state, ignoring legacy paths",
    async (setting) => {
      const home = await tempDir();
      let override = setting;
      if (setting === "absolute") override = join(home, "selected");
      if (setting === "relative") override = relative(process.cwd(), join(home, "selected"));
      const expected = override?.trim() ? resolve(override) : join(home, ".foreman");
      await mkdir(expected, { recursive: true });
      await writeFile(join(expected, "config.json"), '{"codexBin":"/missing/home-codex"}');
      const oldConfig = join(home, "old-config", "test-cli");
      await mkdir(oldConfig, { recursive: true });
      await writeFile(join(oldConfig, "config.json"), "broken");
      const result = await runCli(["doctor", "--json"], {
        home,
        env: {
          CODEX_BIN: undefined,
          FOREMAN_HOME: override,
          FOREMAN_DATA_DIR: join(home, "old-data"),
          TEST_CLI_DATA_DIR: join(home, "old-test-data"),
          XDG_CONFIG_HOME: join(home, "old-config"),
          XDG_DATA_HOME: join(home, "old-xdg-data"),
        },
      });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout))).toMatchObject({
        home: expected,
        configFile: join(expected, "config.json"),
        configError: null,
        codexBin: "/missing/home-codex",
      });
    },
  );

  it.each(["./tools/codex", "tools/codex", "codex"])(
    "resolves relative daemon and Codex paths before changing cwd: %s",
    async (bin) => {
      const result = await runCli(["--json"], {
        env: {
          FOREMAN_HOME: "./relative-data",
          CODEX_HOME: "./relative-home",
          CODEX_BIN: bin,
        },
        program: Effect.gen(function* () {
          const config = yield* AppConfig;
          yield* (yield* Output).result(
            {
              home: config.home,
              codexHome: config.codexHome,
              codexBin: config.codexBin,
              loadedBin: (yield* config.load).codexBin,
            },
            "paths",
          );
        }),
      });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        home: resolve("relative-data"),
        codexHome: resolve("relative-home"),
        codexBin: bin === "codex" ? bin : resolve(bin),
        loadedBin: bin === "codex" ? bin : resolve(bin),
      });
    },
  );

  it("resolves a relative Codex executable from file settings at the caller's cwd", async () => {
    const home = await configFile('{"codexBin":"./tools/file-codex"}');
    const result = await runCli(["--json"], {
      home,
      env: { CODEX_BIN: undefined },
      program: Effect.gen(function* () {
        const config = yield* AppConfig;
        yield* (yield* Output).result(
          { codexBin: config.codexBin, loadedBin: (yield* config.load).codexBin },
          "paths",
        );
      }),
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      codexBin: resolve("tools/file-codex"),
      loadedBin: resolve("tools/file-codex"),
    });
  });

  it("resolves a relative log override from the caller and preserves an absent override", async () => {
    for (const file of ["", "./logs/shared.jsonl"]) {
      const result = await runCli(["--json"], {
        env: { TEST_CLI_LOG_FILE: file },
        program: Effect.gen(function* () {
          yield* (yield* Output).result((yield* (yield* AppConfig).logging).file, "log path");
        }),
      });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toBe(file === "" ? "" : resolve(file));
    }
  });
  it("exposes the environment supplied to each config layer without trimming or dropping values", async () => {
    const home = await tempDir();
    for (const value of [" first ", "second"]) {
      const result = await runCli(["--json"], {
        home,
        env: { PATH: "/fixture/bin", EXTRA_VALUE: value, EMPTY: "" },
        program: Effect.gen(function* () {
          const config = yield* AppConfig;
          yield* (yield* Output).result(config.inheritedEnvironment, "environment");
        }),
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        HOME: home,
        PATH: "/fixture/bin",
        EXTRA_VALUE: value,
        EMPTY: "",
      });
    }
  });
  it.each([
    { env: {}, bin: "codex", home: undefined },
    {
      env: {
        CODEX_BIN: "/tools/codex",
        CODEX_HOME: "/codex-state",
        FOREMAN_CODEX_BIN: "ignored",
        FOREMAN_CODEX_HOME: "ignored",
      },
      bin: "/tools/codex",
      home: "/codex-state",
    },
    { env: { CODEX_BIN: " ", CODEX_HOME: "" }, bin: "codex", home: undefined },
  ])("resolves Codex executable and home from $env", async ({ env, bin, home }) => {
    const temporaryHome = await tempDir();
    const result = await runCli(["--json"], {
      home: temporaryHome,
      env: { CODEX_BIN: undefined, ...env },
      program: Effect.gen(function* () {
        const config = yield* AppConfig;
        yield* (yield* Output).result(
          { codexBin: config.codexBin, codexHome: config.codexHome },
          "Codex settings",
        );
      }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      codexBin: bin,
      codexHome: home ?? join(temporaryHome, ".codex"),
    });
    expect(result.stderr).toBe("");
  });
  it("suppresses successful command records at the default level", async () => {
    const emptyPath = await tempDir();
    const result = await runCli(["doctor", "--json"], {
      env: { CODEX_BIN: undefined, PATH: emptyPath },
    });
    expect(result.status).toBe(0);
    expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout))).toMatchObject({
      codexBin: "codex",
      configError: null,
      codexVersion: null,
      protocolMatches: null,
      loggedIn: null,
    });
    expect(result.stderr).toBe("");
  });
  it.each([
    { args: ["doctor", "--json"], command: "doctor" },
    { args: ["--help", "--json"], command: "framework" },
    { args: ["absent", "--json"], command: null },
  ])("names the command that ran as $command in its record", async ({ args, command }) => {
    const result = await runCli(args, { env: { LOG_LEVEL: "debug" } });
    expect(ndjson(result.stderr)).toContainEqual(
      expect.objectContaining({ msg: "command", command }),
    );
  });
  it("emits failed command records at error at the default level", async () => {
    const result = await runCli(["absent", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(ndjson(result.stderr)).toEqual([
      expect.objectContaining({ msg: "command", level: "error", outcome: "failure", exitCode: 2 }),
      expect.objectContaining({ error: expect.objectContaining({ tag: "Usage" }) }),
    ]);
  });
  it.each([
    { file: "{}", env: {}, levels: [], codexBin: "codex" },
    {
      file: '{"logLevel":"debug","codexBin":"/missing/file-codex"}',
      env: {},
      levels: ["debug", "debug"],
      codexBin: "/missing/file-codex",
    },
    { file: '{"logLevel":"info"}', env: {}, levels: [], codexBin: "codex" },
    {
      file: '{"logLevel":"debug","codexBin":"/missing/file-codex"}',
      env: { LOG_LEVEL: "none", CODEX_BIN: "/missing/env-codex" },
      levels: [],
      codexBin: "/missing/env-codex",
    },
    {
      file: '{"logLevel":"info","codexBin":"/missing/file-codex"}',
      env: { LOG_LEVEL: "", CODEX_BIN: " " },
      levels: [],
      codexBin: "/missing/file-codex",
    },
    {
      file: '{"logLevel":"debug"}',
      env: { LOG_LEVEL: "INFO" },
      levels: [],
      codexBin: "codex",
    },
  ])("resolves file and env while emitting $levels", async ({ file, env, levels, codexBin }) => {
    const home = await configFile(file);
    const emptyPath = await tempDir();
    const log = join(home, "logs", "cli.jsonl");
    const result = await runCli(["doctor", "--json"], {
      home,
      env: {
        CODEX_BIN: undefined,
        PATH: emptyPath,
        ...env,
        TEST_CLI_LOG_FILE: log,
        API_KEY: "PRIVATE_SENTINEL",
      },
    });
    expect(result.status).toBe(0);
    const document = Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout));
    expect(document).toMatchObject({ codexBin, configError: null, compiled: false });
    const records = ndjson(result.stderr);
    expect(
      records.map(
        (record) => Schema.decodeUnknownSync(Schema.Struct({ level: Schema.String }))(record).level,
      ),
    ).toEqual(levels);
    expect(result.stderr).not.toContain("PRIVATE_SENTINEL");
    if (levels.length) {
      expect(ndjson(await readFile(log, "utf8"))).toEqual(records);
      expect(records.at(-1)).toMatchObject({
        msg: "command",
        command: "doctor",
        durationMs: expect.any(Number),
        runId: expect.any(String),
        outcome: "success",
        exitCode: 0,
      });
      for (const record of records)
        expect(record).toMatchObject({ time: expect.stringMatching(/Z$/) });
    } else expect(result.stderr).toBe("");
  });

  it.each(["human", "json"])("reports invalid configuration safely in %s mode", async (mode) => {
    for (const content of [
      '{"logLevel":"loud"}',
      '{"codexBin":7}',
      '{"codexBin":" "}',
      '{"greeting":"old scaffold setting"}',
      '{"apiKey":"PRIVATE_SENTINEL"}',
      "broken",
    ]) {
      const home = await configFile(content);
      const result = await runCli(["doctor", ...(mode === "json" ? ["--json"] : [])], { home });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("configuration unavailable");
      expect(result.stderr).not.toContain("PRIVATE_SENTINEL");
      if (mode === "json")
        expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout))).toMatchObject({
          configError: expect.stringContaining("Invalid configuration"),
        });
      else expect(result.stdout).toContain("Config: Invalid configuration");
    }
  });

  it("keeps invocation state isolated", async () => {
    const first = await runCli(["doctor", "--json"], {
      home: await configFile('{"logLevel":"debug","codexBin":"/missing/first-codex"}'),
      env: { CODEX_BIN: undefined },
    });
    const second = await runCli(["doctor", "--json"], {
      home: await configFile('{"logLevel":"none","codexBin":"/missing/second-codex"}'),
      env: { CODEX_BIN: undefined },
    });
    expect(first.status).toBe(0);
    expect(ndjson(first.stderr)).toHaveLength(2);
    expect(JSON.parse(first.stdout)).toMatchObject({ codexBin: "/missing/first-codex" });
    expect(second).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(second.stdout)).toMatchObject({ codexBin: "/missing/second-codex" });
  });

  it("keeps valid file logging when an unrelated application setting is invalid", async () => {
    const home = await configFile('{"logLevel":"debug","codexBin":7}');
    const result = await runCli(["doctor", "--json"], { home });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      configError: expect.any(String),
    });
    expect(ndjson(result.stderr)).toEqual([
      expect.objectContaining({ msg: "configuration checked", level: "debug" }),
      expect.objectContaining({ msg: "configuration unavailable", level: "warn" }),
      expect.objectContaining({ msg: "command", level: "debug" }),
    ]);
  });

  it("warns once when the file sink fails without failing the command", async () => {
    const home = await configFile('{"logLevel":"debug"}');
    const occupied = join(home, "occupied");
    await writeFile(occupied, "file");
    const result = await runCli(["doctor", "--json"], {
      home,
      env: { TEST_CLI_LOG_FILE: join(occupied, "log") },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ codexBin: join(home, "missing-codex") });
    expect(
      ndjson(result.stderr).filter((record) =>
        JSON.stringify(record).includes("Log file unavailable"),
      ),
    ).toHaveLength(1);
    expect(result.stderr).toContain(join(occupied, "log"));
    expect(result.stderr).toContain("Check the path and directory permissions");
  });

  it("keeps JSON-formatted diagnostics when human output's file sink fails", async () => {
    const home = await configFile('{"logLevel":"debug"}');
    const occupied = join(home, "occupied");
    await writeFile(occupied, "file");
    const result = await runCli(["doctor"], {
      home,
      env: { TEST_CLI_LOG_FILE: join(occupied, "log"), TEST_CLI_LOG_FORMAT: "json" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Codex executable: ${join(home, "missing-codex")}`);
    expect(ndjson(result.stderr)).toEqual([
      expect.objectContaining({ msg: "configuration checked", level: "debug" }),
      expect.objectContaining({
        msg: expect.stringContaining(`Log file unavailable: ${join(occupied, "log")}`),
        level: "warn",
      }),
      expect.objectContaining({ msg: "command", level: "debug" }),
    ]);
  });
});
