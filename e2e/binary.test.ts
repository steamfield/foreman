import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { DaemonResult } from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { PackageInfo } from "../src/schemas/package";
import { askOrchestrator } from "../tests/fixtures/fake-app-server/scenarios";

const metadata = Schema.decodeUnknownSync(PackageInfo)(
  JSON.parse(await readFile("package.json", "utf8")),
);

const binary = resolve("dist", metadata.name);
test.each(["compiled", "development"])(
  "%s wait commands continue through question, timeout, done and none",
  async (mode) => {
    const root = await mkdtemp("/tmp/fm-w-");
    const repo = join(root, "repo");
    const worktree = join(repo, "work");
    const buildDir = join(root, "build path's");
    await mkdir(buildDir);
    const executable = join(buildDir, "forman");
    await copyFile(binary, executable);
    // The fake's env-node shebang uses this runner without consulting a user's version manager.
    await symlink(process.execPath, join(root, "node"));
    await symlink(process.execPath, join(root, "bun"));
    const env = {
      HOME: root,
      CODEX_HOME: join(root, "codex"),
      PATH: `${root}:/usr/bin:/bin`,
      CODEX_BIN: resolve("tests/fixtures/fake-app-server/main.mjs"),
      FORMAN_DATA_DIR: mode === "compiled" ? join(root, "d") : "",
      XDG_DATA_HOME: join(root, "personal"),
      FAKE_APP_SERVER_SCENARIO: join(root, "scenario.json"),
      LOG_LEVEL: "none",
    };
    await mkdir(repo);
    if (mode === "development") {
      await mkdir(join(repo, "scripts"));
      await copyFile("scripts/dev.ts", join(repo, "scripts/dev.ts"));
      for (const entry of ["src", "node_modules", "package.json"])
        await symlink(resolve(entry), join(repo, entry));
    }
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git(["init", "-q"]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    git(["worktree", "add", "-qb", "unit", worktree]);
    await writeFile(env.FAKE_APP_SERVER_SCENARIO, JSON.stringify(askOrchestrator()));
    const contract = join(root, "contract.md");
    await writeFile(contract, "Do the work.\n- May change: `result.txt`");
    const invoke = async (argv: string[]) => {
      const child = Bun.spawn(argv, { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { status, stdout, stderr };
    };
    const run = (args: string[]) =>
      invoke([
        ...(mode === "compiled" ? [executable] : [process.execPath, "run", "--silent", "dev"]),
        ...args,
      ]);
    const runPrinted = (command: string) => invoke(["/bin/sh", "-c", command]);
    const next = (stdout: string) => {
      const line = stdout.trimEnd().split("\n").at(-1);
      expect(line).toMatch(/^next: .+ wait /);
      return (line ?? "").slice("next: ".length);
    };
    try {
      const started = await run(["start", "unit", "--worktree", worktree, "--contract", contract]);
      expect(started).toMatchObject({ status: 0, stderr: "" });
      expect(next(started.stdout)).toEndWith(" wait unit");
      const firstWake = await runPrinted(next(started.stdout));
      expect(firstWake.status).toBe(0);
      expect(firstWake.stdout).toContain("question    unit q1");
      const attention = await run(["wait", "--all", "--timeout", "9m"]);
      expect(attention).toMatchObject({ status: 0, stderr: "" });
      expect(attention.stdout).toContain("question    unit q1");
      const status = await run(["status"]);
      expect(status).toMatchObject({ status: 0, stderr: "" });
      expect(status.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(status.stdout).toMatch(/^unit {2}waiting {2}turn 1 \(start\) {2}\S+ {2}q1 pending\n$/);
      const command = next(attention.stdout);
      expect(command).toContain(" wait --all ");
      const timed = await runPrinted(command.replace(/ --timeout \S+$/, " --timeout 0ms"));
      expect(timed).toMatchObject({ status: 0, stderr: "" });
      expect(timed.stdout.split("\n")[0]).toBe("timeout");
      expect(next(timed.stdout)).toEndWith(" --timeout 0ms");
      expect(await run(["answer", "unit", "q1", "Proceed"])).toEqual({
        status: 0,
        stdout: "ok\n",
        stderr: "",
      });
      const done = await runPrinted(command);
      expect(done).toMatchObject({ status: 0, stderr: "" });
      expect(done.stdout).toContain("done        unit turn 1");
      expect(done.stdout).toContain("No hand-off available.");
      const none = await runPrinted(`${next(done.stdout)} --json`);
      expect(none).toMatchObject({ status: 0, stderr: "" });
      const result = Schema.decodeUnknownSync(DaemonResult)(JSON.parse(none.stdout));
      expect(result).toMatchObject({
        outcome: "none",
        runs: [],
        next: next(done.stdout),
      });
      git(["worktree", "remove", worktree]);
      expect((await run(["status"])).stdout).toMatch(
        /^unit {2}idle {2}turn 1 \(start\) {2}\S+ {2}worktree removed\n$/,
      );
      const named = await run(["status", "unit", "--json"]);
      expect(named).toMatchObject({ status: 0, stderr: "" });
      expect(Schema.decodeUnknownSync(DaemonResult)(JSON.parse(named.stdout))).toMatchObject({
        _tag: "Digests",
        digests: [
          {
            name: "unit",
            state: "idle",
            warnings: expect.arrayContaining([expect.stringContaining("worktree removed:")]),
          },
        ],
      });
    } finally {
      const answered = await run(["answer", "unit", "q1", "Proceed"]);
      expect([0, 7, 8]).toContain(answered.status);
      expect([0, 7]).toContain((await run(["wait", "unit", "--timeout", "1s"])).status);
      expect((await run(["daemon", "stop"])).status).toBe(0);
      if (mode === "development")
        expect(
          (await invoke([process.execPath, resolve("src/bin.ts"), "daemon", "stop"])).status,
        ).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("compiled output, config precedence, log records, errors, and no dotenv autoload", async () => {
  const home = await mkdtemp(join(tmpdir(), "cli-binary-"));
  const prefix = metadata.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  try {
    const config = join(home, "config", metadata.name);
    const log = join(home, "cli.jsonl");
    await mkdir(config, { recursive: true });
    await writeFile(
      join(config, "config.json"),
      JSON.stringify({ logLevel: "debug", codexBin: join(home, "file-codex") }),
    );
    await writeFile(join(home, ".env"), `LOG_LEVEL=none\nCODEX_BIN=dotenv\n`);
    await writeFile(join(home, "bunfig.toml"), "deliberately invalid [");
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const child = Bun.spawn([binary, ...args], {
        cwd: home,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          NO_COLOR: "1",
          [`${prefix}_LOG_FILE`]: log,
          ...extra,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { status, stdout, stderr };
    };
    const result = await run(["doctor", "--json"]);
    expect(result.status).toBe(0);
    expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(result.stdout))).toMatchObject({
      name: metadata.name,
      version: metadata.version ?? "dev",
      compiled: true,
      codexBin: join(home, "file-codex"),
      configError: null,
      codexVersion: null,
      protocolMatches: null,
      loggedIn: null,
      daemon: { state: "not running" },
    });
    const records = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ level: "debug", msg: "configuration checked" });
    expect(records[1]).toMatchObject({ msg: "command", outcome: "success", exitCode: 0 });
    expect(
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(records);
    const overridden = await run(["doctor", "--json"], {
      LOG_LEVEL: "none",
      CODEX_BIN: join(home, "env-codex"),
    });
    expect(overridden.status).toBe(0);
    expect(overridden.stderr).toBe("");
    expect(JSON.parse(overridden.stdout)).toMatchObject({ codexBin: join(home, "env-codex") });
    await writeFile(join(config, "config.json"), "{}");
    const defaultEnvironments: Record<string, string>[] = [{}, { CODEX_BIN: " " }];
    for (const extra of defaultEnvironments) {
      const defaults = await run(["doctor", "--json"], { LOG_LEVEL: "none", ...extra });
      expect(defaults).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(defaults.stdout)).toMatchObject({ codexBin: "codex", configError: null });
    }
    const bad = await run(["doctor", "--unknown", "--json"], { LOG_LEVEL: "none" });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(JSON.parse(bad.stderr)).toMatchObject({ error: { tag: "Usage", retryable: false } });
    await writeFile(join(config, "config.json"), "broken");
    for (const args of [["--help"], ["--version"], ["doctor"]]) {
      const output = await run(args, { LOG_LEVEL: "none" });
      expect(output.status).toBe(0);
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain(
        args[0] === "--version" ? (metadata.version ?? "dev") : metadata.name,
      );
      if (args[0] === "--help") {
        for (const command of [
          "start",
          "status",
          "events",
          "steer",
          "followup",
          "interrupt",
          "answer",
          "result",
          "archive",
          "wait",
          "doctor",
          "daemon",
        ])
          expect(output.stdout).toMatch(new RegExp(`\\b${command}\\b`));
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
