import { execFile, execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/cli";

const exec = promisify(execFile);
// The script runs under Bun; tests run on Node, so find the real Bun before PATH is replaced.
const bunPath = execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8" }).trim();

const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const manifest = (version: string) =>
  `${JSON.stringify(
    {
      name: "@steamfield/foreman",
      version,
      optionalDependencies: Object.fromEntries(
        platforms.map((platform) => [`@steamfield/foreman-${platform}`, version]),
      ),
    },
    null,
    2,
  )}\n`;

// A repo with the files the script rewrites, committed on main at 0.1.2. `bun install` is the one
// fake: it would reach the npm registry, so a stub on PATH records that it ran.
async function repo() {
  const root = await tempDir();
  const bin = join(root, ".bin");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docs"));
  await mkdir(bin);
  await copyFile(resolve("scripts/release.ts"), join(root, "scripts/release.ts"));
  await writeFile(join(root, "package.json"), manifest("0.1.2"));
  await writeFile(
    join(root, "AGENTS.md"),
    "# foreman\n\nforeman 0.1.2 lets Claude Code delegate.\n",
  );
  await writeFile(join(root, "docs/architecture.md"), "# foreman 0.1.2 architecture\n");
  await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## [0.1.2] - 2026-11-15\n");
  await writeFile(join(root, ".gitignore"), ".bin/\n");
  await writeFile(join(bin, "bun"), `#!/bin/sh\necho "$*" >> "${join(bin, "bun.log")}"\n`);
  await chmod(join(bin, "bun"), 0o755);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const release = async (version: string) => {
    try {
      const { stdout } = await exec(bunPath, ["scripts/release.ts", version], {
        cwd: root,
        env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  const read = (file: string) => readFile(join(root, file), "utf8");
  const bunCalls = async () =>
    (await readFile(join(bin, "bun.log"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean);
  return { root, git, release, read, bunCalls };
}

const addChangelog = async (r: Awaited<ReturnType<typeof repo>>, version: string) =>
  writeFile(
    join(r.root, "CHANGELOG.md"),
    `# Changelog\n\n## [${version}] - 2026-11-16\n\n### Fixed\n\n- Something.\n\n## [0.1.2] - 2026-11-15\n`,
  );

describe("bun run release", () => {
  it("bumps every version reference with only the new changelog section uncommitted", async () => {
    const r = await repo();
    await addChangelog(r, "0.1.3");
    const head = r.git("rev-parse", "HEAD");
    const result = await r.release("0.1.3");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Prepared 0.1.2 -> 0.1.3");
    expect(await r.read("package.json")).toBe(manifest("0.1.3"));
    expect(await r.read("AGENTS.md")).toContain("foreman 0.1.3 lets");
    expect(await r.read("docs/architecture.md")).toBe("# foreman 0.1.3 architecture\n");
    expect(await r.bunCalls()).toEqual(["install"]);
    // It prepares the release and leaves committing, tagging and pushing to the person.
    expect(r.git("rev-parse", "HEAD")).toBe(head);
    expect(r.git("tag", "--list")).toBe("");
  });

  it.each([
    {
      name: "uncommitted changes besides the changelog, naming them",
      setup: async (r: Awaited<ReturnType<typeof repo>>) => {
        await addChangelog(r, "0.1.3");
        await writeFile(
          join(r.root, "docs/architecture.md"),
          "# foreman 0.1.2 architecture\nedit\n",
        );
      },
      version: "0.1.3",
      message:
        "the working tree has uncommitted changes besides CHANGELOG.md:\n  docs/architecture.md",
    },
    {
      name: "a version without a changelog section",
      setup: async () => {},
      version: "0.1.3",
      message: 'CHANGELOG.md has no "## [0.1.3] - YYYY-MM-DD" section',
    },
    {
      name: "a version whose tag already exists",
      setup: async (r: Awaited<ReturnType<typeof repo>>) => {
        r.git("tag", "v0.1.3");
        await addChangelog(r, "0.1.3");
      },
      version: "0.1.3",
      message: "tag v0.1.3 already exists",
    },
    {
      name: "a branch other than main",
      setup: async (r: Awaited<ReturnType<typeof repo>>) => {
        r.git("switch", "-q", "-c", "topic");
        await addChangelog(r, "0.1.3");
      },
      version: "0.1.3",
      message: "release from main",
    },
    {
      name: "a version with a leading v",
      setup: async () => {},
      version: "v0.1.3",
      message: "usage: bun run release <major.minor.patch>",
    },
    {
      name: "the version package.json already has",
      setup: async (r: Awaited<ReturnType<typeof repo>>) => addChangelog(r, "0.1.2"),
      version: "0.1.2",
      message: "package.json is already at 0.1.2",
    },
  ])("refuses $name and changes nothing", async ({ setup, version, message }) => {
    const r = await repo();
    await setup(r);
    const before = await r.read("package.json");
    const result = await r.release(version);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`release: ${message}`);
    expect(await r.read("package.json")).toBe(before);
    expect(await r.bunCalls()).toEqual([]);
  });
});
