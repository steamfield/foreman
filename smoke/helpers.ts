import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { activeStates, DaemonResult, RunRecord } from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { cleanupFixture } from "./cleanup";

const binary = resolve(import.meta.dir, "../dist/forman");
const proxy = resolve(import.meta.dir, "codex-proxy.ts");
const Rpc = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
});

export async function fixture(inherited: NodeJS.ProcessEnv = process.env) {
  // /tmp avoids macOS's long per-user TMPDIR; it is the system temp alias there.
  const parent = process.platform === "darwin" ? "/tmp" : tmpdir();
  const root = await mkdtemp(join(parent, "fm-s-"));
  const repo = join(root, "r");
  const worktree = join(repo, "w");
  const data = join(root, "d");
  const transcript: string[] = [];
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(FORMAN_|GIT_|LOG_LEVEL$|XDG_CONFIG_HOME$|OPENAI_API_KEY$|OPENAI_API_BASE$|CODEX_API_KEY$)/.test(
          entry[0],
        ),
    ),
  );
  const realCodex = inherited.CODEX_BIN ?? "codex";
  Object.assign(env, {
    CODEX_BIN: proxy,
    SMOKE_CODEX_BIN: realCodex,
    SMOKE_WIRE: join(root, "wire"),
    FORMAN_DATA_DIR: data,
    XDG_CONFIG_HOME: join(root, "config"),
    LOG_LEVEL: "none",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  let daemonPid: number | undefined;
  let cleaning = false;
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: cleaning ? 10_000 : 21 * 60_000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    transcript.push(`$ forman ${args.join(" ")}\n[exit ${status}]\n${stdout}${stderr}`);
    return { stdout, stderr, status };
  };
  const run = async (args: string[]) => {
    const output = await invoke(args);
    if (args[0] === "start" || args[0] === "followup" || (args[0] === "status" && !daemonPid)) {
      const probe = await invoke(["doctor", "--json"]);
      if (probe.status !== 0) throw new Error(`Could not identify fixture daemon: ${probe.stderr}`);
      const doctor = Schema.decodeUnknownSync(DoctorResult)(JSON.parse(probe.stdout));
      if (doctor.daemon.state === "running") daemonPid = doctor.daemon.pid;
    }
    return output;
  };
  const ok = async (args: string[]) => {
    const output = await run(args);
    expect(output, transcript.at(-1)).toMatchObject({ status: 0, stderr: "" });
    return output.stdout;
  };
  const json = async (args: string[]) =>
    Schema.decodeUnknownSync(DaemonResult)(JSON.parse(await ok([...args, "--json"])));
  const next = (text: string) => {
    const line = text.trimEnd().split("\n").at(-1);
    expect(line).toMatch(/^next: forman wait /);
    if (!line) throw new Error("Missing printed next command");
    return line.slice("next: forman ".length).split(" ");
  };
  const start = async (task: string, extra: string[] = []) => {
    const contract = join(root, "contract.md");
    await writeFile(contract, `${task}\n- May change: \`result.txt\`\nDo not commit.\n`);
    return ok([
      "start",
      "smoke",
      "--worktree",
      worktree,
      "--contract",
      contract,
      "--effort",
      "low",
      ...(extra.includes("--budget") ? [] : ["--budget", "4m"]),
      ...extra,
    ]);
  };
  const until = async (printed: string, kind: string, timeout = "3m") => {
    const deadline = Date.now() + 240_000;
    let command = next(printed);
    while (Date.now() < deadline) {
      const timeoutIndex = command.indexOf("--timeout");
      if (timeoutIndex >= 0) command.splice(timeoutIndex, 2);
      const output = await ok([...command, "--timeout", timeout]);
      command = next(output);
      if (new RegExp(`^${kind} +smoke\\b`, "m").test(output)) return output;
      if (/^(done|failed|interrupted|lost|question) +smoke\b/m.test(output))
        throw new Error(`Expected ${kind}, got:\n${output}`);
    }
    throw new Error(`Timed out waiting for ${kind}`);
  };
  const result = async () => {
    const value = await json(["result", "smoke"]);
    if (value._tag !== "Result") throw new Error(`Expected Result, got ${value._tag}`);
    return value;
  };
  const events = async () => {
    const value = await json(["events", "smoke", "--limit", "1000"]);
    if (value._tag !== "Events") throw new Error(`Expected Events, got ${value._tag}`);
    return value.events;
  };
  const record = async () =>
    Schema.decodeUnknownSync(RunRecord)(
      JSON.parse(await readFile(join(data, "runs/smoke/run.json"), "utf8")),
    );
  const wire = async (direction: "in" | "out") =>
    (await readFile(`${env.SMOKE_WIRE}.${direction}`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => Schema.decodeUnknownSync(Rpc)(JSON.parse(line)));
  const stop = async () => {
    if (daemonPid === undefined) {
      await ok(["daemon", "stop"]);
      return;
    }
    try {
      const status = await json(["status"]);
      if (status._tag !== "Digests") throw new Error("Expected cleanup digests");
      for (const digest of status.digests) {
        if (activeStates.has(digest.state)) {
          await ok(["interrupt", digest.name]);
          let cursor: string | undefined;
          const deadline = Date.now() + 90_000;
          while (true) {
            const current = await json(["status", digest.name]);
            if (current._tag !== "Digests") throw new Error("Expected cleanup status");
            if (current.digests.every((entry) => !activeStates.has(entry.state))) break;
            if (Date.now() > deadline) throw new Error("Cleanup interrupt did not end the turn");
            const wake = await json([
              "wait",
              digest.name,
              "--timeout",
              "30s",
              ...(cursor ? ["--after", cursor] : []),
            ]);
            if (wake._tag !== "Waited") throw new Error("Expected cleanup wait");
            cursor = wake.cursor;
          }
        }
      }
    } finally {
      await ok(["daemon", "stop"]);
    }
  };
  const cleanup = async () => {
    cleaning = true;
    try {
      await cleanupFixture(root, daemonPid, stop);
    } finally {
      console.log(transcript.join("\n"));
    }
  };
  const diagnostics = async () => {
    const paths = ["logs/daemon.jsonl", "logs/app-server.log"];
    const logs = await Promise.allSettled(paths.map((path) => readFile(join(data, path), "utf8")));
    for (const [index, log] of logs.entries()) {
      if (log.status === "fulfilled") console.error(`${paths[index]}:\n${log.value}`);
      else console.error(`Could not read ${paths[index]}:`, log.reason);
    }
  };
  try {
    await mkdir(repo);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git(["init", "-q"]);
    git([
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    git(["worktree", "add", "-qb", "smoke", worktree]);
    return {
      root,
      repo,
      worktree,
      data,
      run,
      ok,
      json,
      next,
      start,
      until,
      result,
      events,
      record,
      wire,
      diagnostics,
      cleanup,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
