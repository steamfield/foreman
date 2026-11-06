import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { afterAll, beforeAll, expect, onTestFinished, test, vi } from "vitest";
import manifest from "../package.json";
import { DoctorResult } from "../src/schemas/doctor";

const exec = promisify(execFile);
const repo = resolve(".");
const target = `${process.platform}-${process.arch}`;
const packageName = `@steamfield/foreman-${target}`;
const packResult = Schema.Array(Schema.Struct({ filename: Schema.String }));
const daemonHomes = new Set<string>();
let root: string;
let installed: string;
let native: string;
let env: NodeJS.ProcessEnv;

async function run(command: string, args: string[], cwd = root, environment = env) {
  try {
    const result = await exec(command, args, { cwd, env: environment, timeout: 60_000 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "number" ||
      !("stdout" in error) ||
      typeof error.stdout !== "string" ||
      !("stderr" in error) ||
      typeof error.stderr !== "string"
    )
      throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopDaemonHomes(homes: readonly string[]) {
  const results = await Promise.allSettled(
    homes.map(async (home) => {
      const environment = { ...env, FOREMAN_HOME: home };
      const diagnostic = await run(native, ["doctor", "--json"], root, environment);
      expect(diagnostic.status).toBe(0);
      const { daemon } = Schema.decodeUnknownSync(DoctorResult)(JSON.parse(diagnostic.stdout));
      expect(daemon.state).not.toBe("unavailable");
      expect(await run(native, ["daemon", "stop"], root, environment)).toMatchObject({
        status: 0,
        stderr: "",
      });
      if (daemon.state === "running")
        await vi.waitFor(() => expect(processAlive(daemon.pid)).toBe(false), {
          timeout: 5000,
          interval: 10,
        });
      daemonHomes.delete(home);
    }),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Could not stop npm test daemons");
}

async function withDaemonHomes(homes: readonly string[], body: () => Promise<void>) {
  for (const home of homes) daemonHomes.add(home);
  const cleanup = () => stopDaemonHomes(homes.filter((home) => daemonHomes.has(home)));
  onTestFinished(cleanup);
  const outcome = await Promise.allSettled([body()]);
  const cleaned = await Promise.allSettled([cleanup()]);
  const errors = [...outcome, ...cleaned]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "npm assertion and cleanup failed");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "foreman-npm-"));
  env = {
    HOME: root,
    PATH: process.env.PATH,
    FOREMAN_HOME: join(root, "state"),
    CODEX_HOME: join(root, "codex"),
    CODEX_BIN: join(root, "missing-codex"),
    LOG_LEVEL: "none",
    npm_config_cache: join(root, "cache"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    CI: "1",
  };
  expect(await run("bun", ["scripts/build.ts", "--npm-host"], repo)).toMatchObject({ status: 0 });
  const tarballs: string[] = [];
  for (const cwd of [join(repo, "dist/npm/foreman"), join(repo, "dist/npm", `foreman-${target}`)]) {
    const packed = await run("npm", ["pack", "--json", "--pack-destination", root], cwd);
    expect(packed.status, packed.stderr).toBe(0);
    const [result] = Schema.decodeUnknownSync(packResult)(JSON.parse(packed.stdout));
    if (!result) throw new Error("npm pack returned no tarball");
    tarballs.push(join(root, result.filename));
  }
  const prefix = join(root, "prefix with spaces");
  const npmCli = await run("npm", [
    "exec",
    "--offline",
    "--call",
    "node -p process.env.npm_execpath",
  ]);
  expect(npmCli.status, npmCli.stderr).toBe(0);
  const runtimeBin = join(root, "runtime-bin");
  await mkdir(runtimeBin);
  await symlink(process.execPath, join(runtimeBin, "node"));
  await symlink(npmCli.stdout.trim(), join(runtimeBin, "npm"));
  // Group discovery needs Git; keep Bun absent to exercise the packed native install.
  const git = await run("which", ["git"]);
  expect(git.status, git.stderr).toBe(0);
  await symlink(git.stdout.trim(), join(runtimeBin, "git"));
  env.PATH = runtimeBin;
  await expect(exec("bun", ["--version"], { env })).rejects.toMatchObject({ code: "ENOENT" });
  const installation = await run("npm", ["install", "-g", "--prefix", prefix, ...tarballs]);
  expect(installation.status, installation.stderr).toBe(0);
  expect(installation.stderr).not.toContain("prepare");
  const published: unknown = JSON.parse(
    await readFile(join(prefix, "lib/node_modules/@steamfield/foreman/package.json"), "utf8"),
  );
  expect(published).not.toHaveProperty("scripts");
  expect(published).not.toHaveProperty("dependencies");
  expect(published).not.toHaveProperty("devDependencies");
  installed = join(prefix, "bin/foreman");
  native = join(prefix, "lib/node_modules", packageName, "bin/foreman");
}, 120_000);

afterAll(async () => {
  if (root) {
    await stopDaemonHomes([...daemonHomes]);
    await rm(root, { recursive: true, force: true });
  }
});

test("packed npm launcher preserves native version, doctor output and usage failures", async () => {
  const version = await run(installed, ["--version"]);
  expect(version).toEqual(await run(native, ["--version"]));
  expect(version).toMatchObject({
    status: 0,
    stdout: `foreman v${manifest.version}\n`,
    stderr: "",
  });
  const doctor = await run(installed, ["doctor", "--json"]);
  expect(doctor).toEqual(await run(native, ["doctor", "--json"]));
  expect(doctor).toMatchObject({ status: 0, stderr: "" });
  expect(Schema.decodeUnknownSync(DoctorResult)(JSON.parse(doctor.stdout))).toMatchObject({
    name: "foreman",
    version: manifest.version,
    compiled: true,
  });
  const args = ["doctor", "argument with spaces", "--json"];
  const failed = await run(installed, args);
  expect(failed).toEqual(await run(native, args));
  expect(failed).toMatchObject({ status: 2, stdout: "" });
  expect(JSON.parse(failed.stderr)).toEqual({
    error: {
      tag: "Usage",
      message: "Invalid command. Run --help for usage.",
      detail: 'Unexpected positional argument: "argument with spaces"',
      retryable: false,
    },
  });
});

test("packed install works on PATH from a scratch directory", async () => {
  const pathEnv = {
    ...env,
    PATH: `${dirname(installed)}:${env.PATH}`,
    FOREMAN_LAUNCHER: "/ignored/inherited-launcher",
  };
  await withDaemonHomes([env.FOREMAN_HOME ?? "", join(root, "wrong-home")], async () => {
    const help = await run("foreman", ["--help"], root, pathEnv);
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("foreman");
    const doctor = await run("foreman", ["doctor"], root, pathEnv);
    expect(doctor).toMatchObject({ status: 0, stderr: "" });
    expect(doctor.stdout).toContain("not running");
    expect(doctor.stdout).toContain("foreman on PATH is this binary: true");
    const diagnostic = await run("foreman", ["doctor", "--json"], root, pathEnv);
    expect(JSON.parse(diagnostic.stdout)).toMatchObject({ foremanOnPath: true });
    const waiting = await run("foreman", ["wait", "--all", "--timeout", "0ms"], root, pathEnv);
    expect(waiting).toMatchObject({ status: 0, stderr: "" });
    const next = waiting.stdout.trimEnd().split("\n").at(-1)?.slice("next: ".length);
    expect(next).toMatch(/^FOREMAN_HOME=\S+ foreman wait /);
    if (!next) throw new Error("No continuation printed");
    const continued = await run("/bin/sh", ["-c", next], root, {
      ...pathEnv,
      FOREMAN_HOME: join(root, "wrong-home"),
    });
    expect(continued).toMatchObject({ status: 0, stderr: "" });
    expect(continued.stdout).toContain(`FOREMAN_HOME=${env.FOREMAN_HOME} foreman wait `);
  });
});

test("packed-install cleanup stops both homes after an assertion fails", async () => {
  const homes = [join(root, "a"), join(root, "b")];
  const pids: number[] = [];
  onTestFinished(() => stopDaemonHomes(homes));
  await expect(
    withDaemonHomes(homes, async () => {
      for (const home of homes) {
        const environment = { ...env, FOREMAN_HOME: home };
        expect(
          await run(installed, ["wait", "--all", "--timeout", "0ms"], root, environment),
        ).toMatchObject({ status: 0 });
        const diagnostic = await run(installed, ["doctor", "--json"], root, environment);
        const { daemon } = Schema.decodeUnknownSync(DoctorResult)(JSON.parse(diagnostic.stdout));
        expect(daemon.state).toBe("running");
        if (daemon.state === "running") pids.push(daemon.pid);
      }
      expect.fail("simulated assertion failure");
    }),
  ).rejects.toThrow("simulated assertion failure");
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(processAlive(pid)).toBe(false);
});

test("launcher names the missing package and unsupported platform", async () => {
  const launcher = join(root, "isolated.cjs");
  await copyFile(join(repo, "npm/foreman.cjs"), launcher);
  const missing = await run(process.execPath, [launcher, "--version"]);
  expect(missing).toMatchObject({ status: 1, stdout: "" });
  expect(missing.stderr).toContain(`missing binary package ${packageName}`);
  expect(missing.stderr).toContain("optional dependencies enabled");
  const unsupported = await run(process.execPath, [
    "-e",
    `Object.defineProperty(process, "platform", { value: "freebsd" }); require(${JSON.stringify(launcher)});`,
  ]);
  expect(unsupported).toMatchObject({ status: 1, stdout: "" });
  expect(unsupported.stderr).toContain(`unsupported platform freebsd-${process.arch}`);
  expect(unsupported.stderr).toContain(`@steamfield/foreman-freebsd-${process.arch}`);
});

test("launcher forwards stdin, arguments, exit codes and signals", async () => {
  const fixture = join(root, "signals");
  const launcher = join(fixture, "foreman.cjs");
  const binary = join(fixture, "node_modules", packageName, "bin/foreman");
  await mkdir(dirname(binary), { recursive: true });
  await copyFile(join(repo, "npm/foreman.cjs"), launcher);
  await writeFile(
    binary,
    `#!${process.execPath}
process.stdin.once("data", (data) => {
  console.error(data.toString().trim());
  console.log(JSON.stringify(process.argv.slice(2)));
  process.exit(42);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.error("forwarded " + signal);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
console.log("ready:" + process.pid);
`,
  );
  await chmod(binary, 0o755);
  const child = spawn(process.execPath, [launcher, "argument with spaces", "literal;$value"], {
    cwd: root,
    env,
    stdio: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.end("stdin passed through\n");
  expect(await closed).toEqual([42, null]);
  expect(stdout).toMatch(/^ready:\d+\n\["argument with spaces","literal;\$value"\]\n$/);
  expect(stderr).toBe("stdin passed through\n");

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const signalled = spawn(process.execPath, [launcher], {
      cwd: root,
      env,
      stdio: "pipe",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    const exited = once(signalled, "close", { signal: AbortSignal.timeout(5000) });
    let signalError = "";
    let pid: number | undefined;
    signalled.stderr.on("data", (chunk) => {
      signalError += chunk.toString();
    });
    onTestFinished(() => {
      signalled.kill("SIGKILL");
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    });
    const [ready] = await once(signalled.stdout, "data", { signal: AbortSignal.timeout(5000) });
    pid = Schema.decodeUnknownSync(Schema.NumberFromString)(ready.toString().trim().split(":")[1]);
    signalled.kill(signal);
    expect(await exited).toEqual([null, signal]);
    expect(signalError).toBe(`forwarded ${signal}\n`);
  }
});

test("launcher exits nonzero when Node ignores a child's termination signal", async () => {
  const fixture = join(root, "signal-exit");
  const launcher = join(fixture, "foreman.cjs");
  const binary = join(fixture, "node_modules", packageName, "bin/foreman");
  await mkdir(dirname(binary), { recursive: true });
  await copyFile(join(repo, "npm/foreman.cjs"), launcher);
  await writeFile(binary, "#!/bin/sh\nkill -XFSZ $$\n");
  await chmod(binary, 0o755);
  expect(await run(process.execPath, [launcher])).toEqual({
    status: 128 + constants.signals.SIGXFSZ,
    stdout: "",
    stderr: "",
  });
});
