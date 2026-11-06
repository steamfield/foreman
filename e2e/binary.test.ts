import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { responseJson } from "../src/daemon/protocol";
import { DaemonResult } from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { PackageInfo } from "../src/schemas/package";
import { askOrchestrator } from "../tests/fixtures/fake-app-server/scenarios";

const metadata = Schema.decodeUnknownSync(PackageInfo)(
  JSON.parse(await readFile("package.json", "utf8")),
);

const binary = resolve("dist", metadata.name);

async function waitForExit(pid: number) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Daemon ${pid} did not exit within 5 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pong = (dataDir: string) =>
  new Promise<Extract<DaemonResult, { _tag: "Pong" }>>((resolve, reject) => {
    const socket = createConnection(join(dataDir, "forman.sock"));
    let buffer = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("Ping timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write('{"id":1,"body":{"_tag":"Ping"}}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      socket.end();
      try {
        const response = Schema.decodeUnknownSync(responseJson)(
          buffer.slice(0, buffer.indexOf("\n")),
        );
        if (!("result" in response) || response.result._tag !== "Pong")
          throw new Error("Expected Pong");
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });

test("starts the daemon in the same data directory when FORMAN_DATA_DIR is relative", async () => {
  const root = await mkdtemp("/tmp/fm-relative-");
  const env = { HOME: root, FORMAN_DATA_DIR: "data", LOG_LEVEL: "none" };
  const run = async (dataDir: string, args: string[]) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: root,
      env: { ...env, FORMAN_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  };
  try {
    expect(await run("data", ["status", "--json"])).toEqual({
      status: 0,
      stdout: '{"_tag":"Digests","digests":[]}\n',
      stderr: "",
    });
    expect((await pong(join(root, "data")))._tag).toBe("Pong");
  } finally {
    // Also clean up the doubled path produced by the regression before its fix.
    for (const directory of [join(root, "data"), join(root, "data", "data")]) {
      expect((await run(directory, ["daemon", "stop"])).status).toBe(0);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

// Merge wiring required in core/commands.ts: pass logFile: (yield* config.logging).file to call().
// Keep this active regression red until the orchestrator wires that locked call site.
test("merge wiring: CLI and daemon share a relative log override from the caller", async () => {
  const root = await mkdtemp("/tmp/fm-log-path-");
  const dataDir = join(root, "data");
  const run = async (args: string[]) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: root,
      env: {
        HOME: root,
        FORMAN_DATA_DIR: dataDir,
        FORMAN_LOG_FILE: "logs/shared.jsonl",
        LOG_LEVEL: "debug",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  };
  try {
    expect((await run(["status", "--json"])).status).toBe(0);
    const started = await pong(dataDir);
    expect((await run(["daemon", "stop"])).status).toBe(0);
    await waitForExit(started.pid);
    const log = await readFile(join(root, "logs/shared.jsonl"), "utf8");
    expect(log).toContain('"command":"status"');
    expect(log).toContain('"msg":"daemon.started"');
  } finally {
    expect((await run(["daemon", "stop"])).status).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

async function buildCopy(root: string) {
  const project = join(root, "build");
  await mkdir(join(project, "scripts"), { recursive: true });
  await cp(resolve("src"), join(project, "src"), { recursive: true });
  for (const file of ["package.json", "bun.lock", "scripts/build.ts"]) {
    await copyFile(resolve(file), join(project, file));
  }
  await symlink(resolve("node_modules"), join(project, "node_modules"));
  const rebuild = async () => {
    const child = Bun.spawn([process.execPath, "run", "build"], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stdout, stderr }).toMatchObject({ status: 0 });
    return join(project, "dist", metadata.name);
  };
  return { project, rebuild };
}

test("compiled identities survive identical rebuilds and replace idle daemons after a source edit", async () => {
  const root = await mkdtemp("/tmp/fm-b-");
  const env = { HOME: root, FORMAN_DATA_DIR: join(root, "d"), LOG_LEVEL: "none" };
  const { project, rebuild } = await buildCopy(root);
  const run = async (args: string[], fromSource = false) => {
    const executable = fromSource
      ? [process.execPath, join(project, "src/bin.ts")]
      : [join(project, "dist", metadata.name)];
    const child = Bun.spawn([...executable, ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  };
  try {
    await rebuild();
    expect(await run(["status", "--json"])).toMatchObject({ status: 0, stderr: "" });
    const first = await pong(env.FORMAN_DATA_DIR);
    expect(first.build).toMatch(/^[a-f0-9]{64}$/);
    await rebuild();
    expect(await run(["status", "--json"])).toMatchObject({ status: 0, stderr: "" });
    expect(await pong(env.FORMAN_DATA_DIR)).toEqual(first);
    const source = join(project, "src/bin.ts");
    await writeFile(source, `${await readFile(source, "utf8")}\n// Changed build input.\n`);
    await rebuild();
    expect(await run(["status", "--json"])).toMatchObject({ status: 0, stderr: "" });
    const second = await pong(env.FORMAN_DATA_DIR);
    expect(second.pid).not.toBe(first.pid);
    expect(second.build).not.toBe(first.build);
    await waitForExit(first.pid);
    expect(await run(["status", "--json"], true)).toMatchObject({ status: 0, stderr: "" });
    const dev = await pong(env.FORMAN_DATA_DIR);
    expect(dev.build).toBe(`dev-${second.build}`);
    await waitForExit(second.pid);
    expect(await run(["status", "--json"], true)).toMatchObject({ status: 0, stderr: "" });
    expect(await pong(env.FORMAN_DATA_DIR)).toEqual(dev);
    await writeFile(source, `${await readFile(source, "utf8")}\n// Changed dev input.\n`);
    expect(await run(["status", "--json"], true)).toMatchObject({ status: 0, stderr: "" });
    const editedDev = await pong(env.FORMAN_DATA_DIR);
    expect(editedDev.pid).not.toBe(dev.pid);
    expect(editedDev.build).not.toBe(dev.build);
    await waitForExit(dev.pid);
  } finally {
    const stopped = await pong(env.FORMAN_DATA_DIR);
    expect((await run(["daemon", "stop"])).status).toBe(0);
    await waitForExit(stopped.pid);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

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
      let upgrade: { busy: Extract<DaemonResult, { _tag: "Pong" }>; binary: string } | undefined;
      if (mode === "compiled") {
        const busy = await pong(env.FORMAN_DATA_DIR);
        const { project, rebuild } = await buildCopy(root);
        const source = join(project, "src/bin.ts");
        await writeFile(source, `${await readFile(source, "utf8")}\n// Busy upgrade build.\n`);
        const upgraded = await rebuild();
        const outdated = await invoke([upgraded, "status", "--json"]);
        expect(outdated.status).toBe(0);
        expect(outdated.stderr).toBe(
          "Daemon is outdated; it will be replaced once its runs finish.\n",
        );
        expect(Schema.decodeUnknownSync(DaemonResult)(JSON.parse(outdated.stdout))).toMatchObject({
          _tag: "Digests",
          digests: [{ name: "unit", state: "waiting" }],
        });
        expect(await pong(env.FORMAN_DATA_DIR)).toEqual(busy);
        upgrade = { busy, binary: upgraded };
      }
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
      const answered = await run(["answer", "unit", "q1", "Proceed"]);
      expect(answered).toMatchObject({ status: 0, stderr: "" });
      expect(answered.stdout).toMatch(/^ok\nnext: /);
      const done = await runPrinted(next(answered.stdout));
      expect(done).toMatchObject({ status: 0, stderr: "" });
      expect(done.stdout).toContain("done        unit turn 1");
      expect(done.stdout).toContain("No hand-off available.");
      if (upgrade !== undefined) {
        const replacement = join(buildDir, "forman.next");
        await copyFile(upgrade.binary, replacement);
        await rename(replacement, executable);
        expect(await run(["status", "--json"])).toMatchObject({ status: 0, stderr: "" });
        const replaced = await pong(env.FORMAN_DATA_DIR);
        expect(replaced.pid).not.toBe(upgrade.busy.pid);
        expect(replaced.build).not.toBe(upgrade.busy.build);
        await waitForExit(upgrade.busy.pid);
      }
      const allNext = `${next(done.stdout).replace(" wait unit ", " wait --all ")} --timeout 9m`;
      const none = await runPrinted(`${allNext} --json`);
      expect(none).toMatchObject({ status: 0, stderr: "" });
      const result = Schema.decodeUnknownSync(DaemonResult)(JSON.parse(none.stdout));
      expect(result).toMatchObject({
        outcome: "none",
        runs: [],
        next: allNext,
      });
      expect(result).toMatchObject({
        next: expect.stringMatching(/ wait --all --after \S+ --timeout 9m$/),
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

test("one question delegation takes exactly two calls using printed attention", async () => {
  const root = await mkdtemp("/tmp/fm-two-");
  const repo = join(root, "repo");
  const worktree = join(repo, "work");
  const env = {
    HOME: root,
    CODEX_HOME: join(root, "codex"),
    PATH: `${root}:/usr/bin:/bin`,
    CODEX_BIN: resolve("tests/fixtures/fake-app-server/main.mjs"),
    FORMAN_DATA_DIR: join(root, "d"),
    FAKE_APP_SERVER_SCENARIO: join(root, "scenario.json"),
    LOG_LEVEL: "none",
  };
  await mkdir(repo);
  await symlink(process.execPath, join(root, "node"));
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
  const contract = join(root, "contract.md");
  await writeFile(contract, "Do the work.");
  await writeFile(env.FAKE_APP_SERVER_SCENARIO, JSON.stringify(askOrchestrator()));
  let calls = 0;
  const run = async (args: string[], statuses = [0]) => {
    calls += 1;
    const child = Bun.spawn([binary, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(statuses).toContain(status);
    if (status === 0) expect(stderr).toBe("");
    return stdout;
  };
  try {
    const attention = await run([
      "start",
      "unit",
      "--worktree",
      worktree,
      "--contract",
      contract,
      "--wait",
      "--timeout",
      "5s",
    ]);
    const question = /^question\s+(\S+) (q\d+) /m.exec(attention);
    expect(question).not.toBeNull();
    const [, name, id] = question ?? [];
    if (!name || !id) throw new Error("Expected a printed run name and question id");
    const done = await run(["answer", name, id, "Proceed", "--wait", "--timeout", "5s"]);
    expect(done).toContain(`done        ${name} turn 1`);
    expect(calls).toBe(2);
  } finally {
    await run(["answer", "unit", "q1", "Proceed"], [0, 7, 8]);
    const child = Bun.spawn([binary, "daemon", "stop"], {
      cwd: repo,
      env,
      stdout: "ignore",
      stderr: "inherit",
    });
    expect(await child.exited).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("compiled output, config precedence, log records, errors, and no dotenv autoload", async () => {
  const home = await mkdtemp(join(tmpdir(), "cli-binary-"));
  const prefix = metadata.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  try {
    const config = join(home, "config", metadata.name);
    const log = join(home, "cli.jsonl");
    const emptyPath = join(home, "empty-bin");
    await mkdir(emptyPath);
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
          PATH: emptyPath,
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
      const defaults = await run(["doctor", "--json"], {
        LOG_LEVEL: "none",
        PATH: emptyPath,
        ...extra,
      });
      expect(defaults).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(defaults.stdout)).toMatchObject({
        codexBin: "codex",
        configError: null,
        codexVersion: null,
        protocolMatches: null,
        loggedIn: null,
      });
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
