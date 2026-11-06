import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";
import { ErrorEnvelope } from "../src/errors";
import { DoctorResult } from "../src/schemas/doctor";
import { runCli, tempDir } from "./helpers/cli";

const quiet = { LOG_LEVEL: "none" };

describe("actionable CLI diagnostics", () => {
  it.each([
    ["wait", "unit", "--timeout", "5minutes"],
    ["start", "unit", "--new-worktree", "--contract", "absent", "--budget", "1.5m"],
    ["start", "unit", "--new-worktree", "--contract", "absent", "--question-timeout", "-1s"],
    ["followup", "unit", "continue", "--budget", "999999999999999999h"],
  ])("names the invalid duration and format: %j", async (...args) => {
    const flag = args.at(-2);
    const value = args.at(-1);
    for (const json of [false, true]) {
      const result = await runCli([...args, ...(json ? ["--json"] : [])], { env: quiet });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(flag);
      expect(result.stderr).toContain(value);
      expect(result.stderr).toContain("nonnegative whole number");
      expect(result.stderr).toContain("ms, s, m or h");
      if (json) {
        const envelope = Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
        expect(envelope.error).toMatchObject({ tag: "Usage", retryable: false });
      }
      expect(result.stderr.match(/Invalid command\./g)).toHaveLength(1);
    }
  });

  it("names the missing required flag in one report", async () => {
    for (const json of [false, true]) {
      const result = await runCli(
        ["start", "unit", "--new-worktree", ...(json ? ["--json"] : [])],
        { env: quiet },
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Missing required flag: --contract");
      expect(result.stderr.match(/Invalid command\./g)).toHaveLength(1);
      if (json) Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
    }
  });

  it("does not expose secrets in duration values or unrelated parser errors", async () => {
    for (const args of [
      ["wait", "unit", "--timeout", "sk-private-duration-secret"],
      ["followup", "unit", "PRIVATE_MESSAGE", "unexpected"],
    ]) {
      const result = await runCli([...args, "--json"], { env: quiet });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("sk-private-duration-secret");
      expect(result.stderr).not.toContain("PRIVATE_MESSAGE");
      Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
    }
  });

  it.each(["contract", "steer", "followup", "answer"])(
    "classifies a missing %s file as an input error",
    async (kind) => {
      const home = await tempDir();
      const file = join(home, "missing.md");
      const args =
        kind === "contract"
          ? ["start", "unit", "--new-worktree", "--contract", file]
          : [kind, "unit", ...(kind === "answer" ? ["q1"] : []), "--file", file];
      for (const json of [false, true]) {
        const result = await runCli([...args, ...(json ? ["--json"] : [])], { env: quiet });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(file);
        expect(result.stderr).toContain("Create the file or correct its path");
        expect(result.stderr).not.toContain("worktree");
        if (json)
          expect(
            Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr)).error,
          ).toMatchObject({ tag: "InputError", retryable: false });
      }
    },
  );

  it.each(["contract", "steer", "followup", "answer"])(
    "names an unreadable %s file without exposing its contents",
    async (kind) => {
      const home = await tempDir();
      const file = join(home, "private.md");
      await writeFile(file, "PRIVATE_FILE_CONTENT");
      await chmod(file, 0);
      onTestFinished(() => chmod(file, 0o600));
      const args =
        kind === "contract"
          ? ["start", "unit", "--new-worktree", "--contract", file]
          : [kind, "unit", ...(kind === "answer" ? ["q1"] : []), "--file", file];
      for (const json of [false, true]) {
        const result = await runCli([...args, ...(json ? ["--json"] : [])], { env: quiet });
        expect(result.status).toBe(6);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(file);
        expect(result.stderr).toContain("Grant read access or choose another file");
        expect(result.stderr).not.toContain("PRIVATE_FILE_CONTENT");
        if (json) Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
      }
    },
  );

  it.each([
    { content: '{"unknown":"PRIVATE_CONFIG_CONTENT"}', diagnosis: "unknown" },
    { content: '{"logLevel":"PRIVATE_CONFIG_CONTENT"}', diagnosis: "logLevel" },
    { content: '{"codexBin":7}', diagnosis: "codexBin" },
    { content: '{"codexBin":" "}', diagnosis: "codexBin" },
    { content: '{"apiKey":"PRIVATE_CONFIG_CONTENT"}', diagnosis: "apiKey" },
    { content: '{"sk-private-config-key":"PRIVATE_CONFIG_CONTENT"}', diagnosis: "[redacted]" },
    { content: '{"codexBin":"PRIVATE_CONFIG_CONTENT"', diagnosis: "JSON" },
    { content: '"PRIVATE_CONFIG_CONTENT"', diagnosis: "object" },
  ])("names the invalid config location safely: $diagnosis", async ({ content, diagnosis }) => {
    const home = await tempDir();
    const directory = join(home, ".forman");
    const file = join(directory, "config.json");
    await mkdir(directory);
    await writeFile(file, content);
    for (const json of [false, true]) {
      const result = await runCli(["status", ...(json ? ["--json"] : [])], { home, env: quiet });
      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(file);
      expect(result.stderr).toContain(diagnosis);
      expect(result.stderr).not.toContain("PRIVATE_CONFIG_CONTENT");
      expect(result.stderr).not.toContain("sk-private-config-key");
      if (json) Schema.decodeUnknownSync(ErrorEnvelope)(JSON.parse(result.stderr));
    }
    const doctor = await runCli(["doctor", "--json"], { home, env: quiet });
    expect(doctor.status).toBe(0);
    const result = Schema.decodeUnknownSync(DoctorResult)(JSON.parse(doctor.stdout));
    expect(result.configError).toContain(file);
    expect(result.configError).toContain(diagnosis);
    expect(doctor.stdout).not.toContain("PRIVATE_CONFIG_CONTENT");
  });
});
