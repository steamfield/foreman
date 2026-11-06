import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import type { Command } from "effect/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli } from "../src/cli";
import { mentionedCommands } from "../src/core/guide";
import { ErrorEnvelope } from "../src/errors";
import { skillText } from "../src/guide/skill";
import { guideTopics } from "../src/guide/topics";
import { GuideResult } from "../src/schemas/guide";
import { SkillResult } from "../src/schemas/skill";
import { ndjson, runCli, tempDir } from "./helpers/cli";

function commandPaths(command: Command.Command.Any, parent: readonly string[] = []): string[][] {
  const path = [...parent, command.name];
  return [
    path.slice(1),
    ...command.subcommands.flatMap((group) =>
      group.commands.flatMap((child) => commandPaths(child, path)),
    ),
  ];
}

const paths = commandPaths(cli("foreman"));
const helps = new Map<string, string>();
let helpHome: string;

beforeAll(async () => {
  helpHome = await mkdtemp(join(tmpdir(), "foreman-help-"));
  for (const path of paths) {
    const result = await runCli([...path, "--help"], { home: helpHome });
    expect(result.status, path.join(" ")).toBe(0);
    expect(result.stderr).toBe("");
    helps.set(path.join(" "), result.stdout);
  }
});
afterAll(async () => {
  await rm(helpHome, { recursive: true, force: true });
});

describe("installed guidance", () => {
  it("ends only root help with the agent starting point, including JSON help", async () => {
    expect(helps.get("")?.trimEnd()).toMatch(
      /Start here \(agents\): run foreman guide[^\n]+\nUse foreman guide <topic>[^\n]+$/,
    );
    for (const [path, help] of helps) {
      if (path !== "") expect(help).not.toContain("Start here (agents)");
    }
    const result = await runCli(["--help", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ help: helps.get("")?.slice(0, -1) });
  });

  it.each(paths.map((path) => ({ path })))(
    "documents examples, exit codes and every positional argument: $path",
    ({ path }) => {
      const help = helps.get(path.join(" ")) ?? "";
      expect(help).toMatch(/Exits /);
      expect(help).toContain("130");
      expect(help).toContain("EXAMPLES");
      const examples = help.split("EXAMPLES")[1] ?? "";
      expect((examples.match(/^ {2}foreman /gm) ?? []).length).toBeGreaterThanOrEqual(2);
      const arguments_ = help
        .split("ARGUMENTS\n")[1]
        ?.split(/\n(?:FLAGS|INHERITED FLAGS|GLOBAL FLAGS|EXAMPLES)/)[0];
      if (arguments_) {
        for (const line of arguments_.trim().split("\n")) {
          expect(line.trim()).toMatch(/^\S+ \S+\s+\S.+/);
        }
      }
    },
  );

  it.each(Object.entries(guideTopics))(
    "prints %s in text and typed JSON without creating state",
    async (topic, text) => {
      const home = await tempDir();
      const data = join(home, "state");
      const env = { FOREMAN_HOME: data };
      const parts = topic === "core" ? [] : topic.split(" ");
      const plain = await runCli(["guide", ...parts], { home, env });
      expect(plain).toEqual({ status: 0, stdout: `${text.trimEnd()}\n`, stderr: "" });
      const machine = await runCli(["guide", ...parts, "--json"], { home, env });
      expect(machine.status).toBe(0);
      expect(machine.stderr).toBe("");
      const result = Schema.decodeUnknownSync(GuideResult)(JSON.parse(machine.stdout));
      expect(result).toEqual({
        topic,
        text: text.trimEnd(),
        topics: Object.keys(guideTopics),
        commands: mentionedCommands(text),
      });
      expect(await readdir(home)).toEqual([]);
    },
  );

  it("rejects an unknown topic with usage and the available topics", async () => {
    const result = await runCli(["guide", "missing", "--json"], { env: { LOG_LEVEL: "none" } });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const { error } = Schema.decodeUnknownSync(ErrorEnvelope)(ndjson(result.stderr).at(-1));
    expect(error.tag).toBe("Usage");
    for (const topic of Object.keys(guideTopics)) expect(error.detail).toContain(topic);
  });

  it("keeps the generated skill identical and the entry points short", async () => {
    expect(await readFile("skills/foreman/SKILL.md", "utf8")).toBe(skillText);
    const body = skillText.split("---\n").at(-1)?.trim() ?? "";
    expect(body.split("\n").length).toBeLessThanOrEqual(15);
    expect(guideTopics.core.split("\n").length).toBeLessThanOrEqual(40);
    expect(body).toContain("Before the first foreman command in a session, run `foreman guide`");
  });

  it("names only commands and flags that the real command tree exposes", () => {
    const texts = [...Object.values(guideTopics), skillText];
    const flags = new Set(
      [...helps.values()].flatMap((help) =>
        [...help.matchAll(/^ {2}(--[\w-]+)/gm)].map(([flag]) => flag.trim()),
      ),
    );
    const commands = new Set(paths.map((path) => `foreman ${path.join(" ")}`.trim()));
    for (const text of texts) {
      for (const command of mentionedCommands(text)) expect(commands, command).toContain(command);
      const foremanText = text.replace(/```sh\n([\s\S]*?)```/g, (_fence, shell: string) =>
        shell
          .split("\n")
          .filter((line) => /\bforeman\b/.test(line))
          .join("\n"),
      );
      for (const [flag] of foremanText.matchAll(/--[a-z][a-z-]*/g))
        expect(flags, flag).toContain(flag);
    }
    expect(mentionedCommands("foreman removed --missing")).toContain("foreman removed");
    expect(commands).not.toContain("foreman removed");
    expect(flags).not.toContain("--missing");
  });

  it("explains answer delivery and the states that change it", () => {
    const help = helps.get("answer") ?? "";
    for (const phrase of [
      "pending",
      "deferred",
      "correction",
      "inactive",
      "hand-off",
      "queue",
      "another question",
      "outdated",
    ]) {
      expect(help).toContain(phrase);
    }
  });

  it("documents the daemon's successful no-op when another process owns its home", () => {
    expect(helps.get("daemon")).toContain(
      "already owned by another daemon exits 0 without starting another",
    );
  });

  it("documents start flag combinations", () => {
    const help = helps.get("start") ?? "";
    const from = help.split("\n").find((line) => line.trimStart().startsWith("--from "));
    const setup = help.split("\n").find((line) => line.trimStart().startsWith("--setup "));
    expect(from).toContain("requires --new-worktree");
    expect(setup).toContain("requires --new-worktree");
  });

  it("documents replacement of inactive runs separately from thread continuation", () => {
    const help = helps.get("start") ?? "";
    expect(help).toContain("archives its previous records after successful preflight");
    expect(help).toContain("followup to continue its saved thread");
  });

  it("pins the first-use start to the contract review model and checks status while waiting", () => {
    const example =
      guideTopics.core.split("\n").find((line) => line.includes("foreman start doctor-help")) ?? "";
    expect(example).toMatch(/--model gpt-[\w.-]+/);
    expect(guideTopics.core).toContain("models_cache.json");
    expect(guideTopics.core).toContain("foreman status doctor-help");
    expect(guideTopics.core).toContain("same literal model");
  });
});

describe("bundled skill installation", () => {
  it("installs, leaves identical content unchanged, refuses differences, and force replaces", async () => {
    const home = await tempDir();
    const target = join(home, ".claude", "skills", "foreman", "SKILL.md");
    const run = (...flags: string[]) =>
      runCli(["skill", "install", ...flags], {
        home,
        env: { FOREMAN_HOME: join(home, "state"), LOG_LEVEL: "none" },
      });
    const installed = await run("--json");
    expect(installed.status).toBe(0);
    expect(installed.stderr).toBe("");
    expect(Schema.decodeUnknownSync(SkillResult)(JSON.parse(installed.stdout))).toEqual({
      name: "foreman",
      path: target,
      action: "written",
    });
    expect(await readFile(target, "utf8")).toBe(skillText);
    const info = await lstat(target);
    expect(await run()).toEqual({ status: 0, stdout: `Unchanged: ${target}\n`, stderr: "" });
    expect((await lstat(target)).mtimeMs).toBe(info.mtimeMs);
    await writeFile(target, "edited copy\n");
    const refused = await run();
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("--force");
    expect(await readFile(target, "utf8")).toBe("edited copy\n");
    expect(await run("--force")).toEqual({
      status: 0,
      stdout: `Installed: ${target}\n`,
      stderr: "",
    });
    expect(await readFile(target, "utf8")).toBe(skillText);
    expect(await readdir(home)).toEqual([".claude"]);
  });

  it("prints without HOME or target lookup and respects JSON output", async () => {
    const home = await tempDir();
    const options = {
      home,
      env: { HOME: undefined, FOREMAN_HOME: join(home, "state"), LOG_LEVEL: "none" },
    };
    expect(await runCli(["skill", "install", "--print"], options)).toEqual({
      status: 0,
      stdout: skillText,
      stderr: "",
    });
    const result = await runCli(["skill", "install", "--print", "--json"], options);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Schema.decodeUnknownSync(SkillResult)(JSON.parse(result.stdout))).toEqual({
      name: "foreman",
      action: "printed",
      path: null,
      text: skillText,
    });
    const refused = await runCli(["skill", "install"], options);
    expect(refused.status).toBe(6);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("HOME is unset");
    expect(await readdir(home)).toEqual([]);
  });

  it.each([false, true])("refuses a non-file target even with force=%s", async (force) => {
    const home = await tempDir();
    const target = join(home, ".claude", "skills", "foreman", "SKILL.md");
    await mkdir(target, { recursive: true });
    const result = await runCli(["skill", "install", ...(force ? ["--force"] : [])], { home });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("regular file");
  });

  it("refuses linked install directories and files without writing through them", async () => {
    const home = await tempDir();
    const elsewhere = await tempDir();
    await symlink(elsewhere, join(home, ".claude"));
    const result = await runCli(["skill", "install", "--force"], { home });
    expect(result.status).toBe(6);
    expect(result.stdout).toBe("");
    expect(await readdir(elsewhere)).toEqual([]);
    const otherHome = await tempDir();
    const dir = join(otherHome, ".claude", "skills", "foreman");
    await mkdir(dir, { recursive: true });
    const external = join(elsewhere, "SKILL.md");
    await writeFile(external, "personal skill");
    await symlink(external, join(dir, "SKILL.md"));
    const linked = await runCli(["skill", "install", "--force"], { home: otherHome });
    expect(linked.status).toBe(6);
    expect(linked.stdout).toBe("");
    expect(await readFile(external, "utf8")).toBe("personal skill");
  });

  it("reports an unwritable directory as permission denied", async () => {
    const home = await tempDir();
    const dir = join(home, ".claude");
    await mkdir(dir);
    await chmod(dir, 0o500);
    try {
      const result = await runCli(["skill", "install"], { home });
      expect(result.status).toBe(6);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("permissions");
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
