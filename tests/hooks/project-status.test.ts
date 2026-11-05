import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, makeFixture, runHook } from "../helpers/hooks";

let project: Fixture;
// Where the hook keeps its log offset; per test, so no state leaks between them or from the machine.
let tmp: string;

// The bun that runs the hook (the one on PATH), so a fixture can pin it or not.
const BUN_VERSION = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();

const put = (name: string, content = "", dir = project.real) => {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};
const status = async (dir = project.real) => {
  const result = await runHook(
    "SessionStart",
    "project-status",
    { session_id: "s", hook_event_name: "SessionStart", source: "startup" },
    { env: { CLAUDE_PROJECT_DIR: dir, TMPDIR: tmp } },
  );
  expect(result.code).toBe(0);
  return result.stdout;
};

beforeEach(() => {
  project = makeFixture();
  tmp = mkdtempSync(join(tmpdir(), "hook-tmp-"));
});
afterEach(() => {
  project.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

describe("project-status", { timeout: 30_000 }, () => {
  it("says nothing for a set-up checkout", async () => {
    put("package.json", JSON.stringify({ packageManager: `bun@${BUN_VERSION}` }));
    expect(await status()).toBe("");
  });

  it("notes a bun that differs from packageManager", async () => {
    put("package.json", JSON.stringify({ packageManager: "bun@0.0.1" }));
    expect(await status()).toContain(
      `bun ${BUN_VERSION} is on PATH, but package.json pins bun@0.0.1 (packageManager)`,
    );
  });

  it("counts warn and error lines in logs/cli.jsonl", async () => {
    put(
      "logs/cli.jsonl",
      [
        '{"time":"t","level":"info","msg":"command"}',
        '{"time":"t","level":"warn","msg":"Model call failed before any output; retrying"}',
        '{"time":"t","level":"error","msg":"defect"}',
        '{"time":"t","level":"fatal","msg":"boom"}',
        "",
      ].join("\n"),
    );
    expect(await status()).toContain("logs/cli.jsonl has 3 warn/error line(s): jq -c");
  });

  it("counts only the lines appended since the previous session started", async () => {
    const first = '{"time":"t","level":"error","msg":"old"}\n';
    put("logs/cli.jsonl", first);
    expect(await status()).toContain("logs/cli.jsonl has 1 warn/error line(s)");
    // Nothing new: the old error was reported last time.
    expect(await status()).not.toContain("cli.jsonl");

    appendFileSync(
      join(project.real, "logs/cli.jsonl"),
      '{"time":"t","level":"warn","msg":"new"}\n{"time":"t","level":"info","msg":"command"}\n',
    );
    expect(await status()).toContain(
      `logs/cli.jsonl has 1 new warn/error line(s) since the last session started: tail -c +${first.length + 1} logs/cli.jsonl | jq -c`,
    );
    expect(await status()).not.toContain("cli.jsonl");
  });

  it("leaves a line still being written for the next session", async () => {
    put("logs/cli.jsonl", '{"time":"t","level":"info","msg":"command"}\n{"time":"t","level":"err');
    expect(await status()).not.toContain("cli.jsonl");
    appendFileSync(join(project.real, "logs/cli.jsonl"), 'or","msg":"defect"}\n');
    expect(await status()).toContain("logs/cli.jsonl has 1 new warn/error line(s)");
  });

  it("starts over when the log was rotated or truncated", async () => {
    put("logs/cli.jsonl", '{"time":"t1","level":"error","msg":"old"}\n'.repeat(3));
    expect(await status()).toContain("has 3 warn/error line(s)");

    // Rotated (scripts/dev.ts renames it to cli.prev.jsonl): a new file, even if it's longer.
    renameSync(join(project.real, "logs/cli.jsonl"), join(project.real, "logs/cli.prev.jsonl"));
    put("logs/cli.jsonl", '{"time":"t2","level":"warn","msg":"new"}\n'.repeat(4));
    expect(await status()).toContain("logs/cli.jsonl has 4 warn/error line(s): jq -c");

    // Truncated in place to something shorter.
    put("logs/cli.jsonl", '{"time":"t3","level":"warn","msg":"new"}\n');
    expect(await status()).toContain("logs/cli.jsonl has 1 warn/error line(s): jq -c");
  });

  it("keeps a separate offset per checkout", async () => {
    put("logs/cli.jsonl", '{"time":"t","level":"error","msg":"x"}\n');
    expect(await status()).toContain("has 1 warn/error line(s)");
    const other = makeFixture();
    try {
      put("logs/cli.jsonl", '{"time":"t","level":"error","msg":"x"}\n', other.real);
      expect(await status(other.real)).toContain("logs/cli.jsonl has 1 warn/error line(s)");
    } finally {
      other.cleanup();
    }
  });

  it("says nothing about a clean log", async () => {
    put("logs/cli.jsonl", '{"time":"t","level":"info","msg":"command"}\n');
    expect(await status()).not.toContain("cli.jsonl");
  });
});
