import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  DaemonLockOwner,
  DaemonResult,
  QuestionLine,
  RunEvent,
  RunRecord,
} from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";

const execute = promisify(execFile);
const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const entry = resolve("src/bin.ts");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function exited(pid: number) {
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`Owned process ${pid} survived cleanup`);
    await setImmediate();
  }
}

it("seeded stress: concurrent delegations recover from daemon SIGKILL and app-server exits", async () => {
  const seed = 210021;
  console.log(`forman stress seed=${seed}`);
  let random = seed;
  const next = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random;
  };
  const root = await realpath(await mkdtemp("/tmp/fm-stress-"));
  const repo = `${root}/repo`;
  const data = `${root}/d`;
  const pids = new Set<number>();
  const expectedNames = new Set<string>();
  const fakePids = `${root}/fake-pids`;
  const env = {
    HOME: root,
    PATH: `${dirname(bun)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_HOME: `${root}/codex`,
    CODEX_BIN: `${root}/codex-wrapper`,
    FORMAN_HOME: data,
    LOG_LEVEL: "none",
    FAKE_APP_SERVER_SCENARIO: `${root}/scenario.json`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  await mkdir(repo);
  await writeFile(fakePids, "");
  await writeFile(
    env.CODEX_BIN,
    `#!/bin/sh\ncase "$*" in 'app-server --listen stdio://') echo $$ >> '${fakePids}';; esac\nexec '${process.execPath}' '${resolve("tests/fixtures/fake-app-server/main.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
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
  await writeFile(`${root}/contract.md`, "Run the scripted task. Do not commit.");
  await writeFile(
    env.FAKE_APP_SERVER_SCENARIO,
    JSON.stringify({
      rules: [
        {
          method: "thread/start",
          repeat: true,
          respond: {
            result: {
              model: "test",
              serviceTier: "priority",
              cwd: repo,
              sandbox: { type: "readOnly", networkAccess: false },
            },
          },
        },
        {
          method: "turn/start",
          repeat: true,
          respond: { result: { turn: { status: "inProgress", error: null, items: [] } } },
          steps: [
            {
              notify: "turn/started",
              params: {
                threadId: "{{thread}}",
                turn: { id: "{{turn}}", status: "inProgress", error: null, items: [] },
              },
            },
            {
              request: "item/tool/call",
              label: "question-{{seq}}",
              params: {
                threadId: "{{thread}}",
                turnId: "{{turn}}",
                callId: "call-{{seq}}",
                namespace: null,
                tool: "ask_orchestrator",
                arguments: { question: "Stress question" },
              },
            },
          ],
        },
        { method: "turn/steer", repeat: true, respond: { result: { turnId: "{{turn}}" } } },
        { method: "turn/interrupt", repeat: true, respond: { result: {} }, steps: [{ exit: 17 }] },
      ],
    }),
  );
  const run = async (args: string[]) => {
    const result = await execute(bun, [entry, ...args, "--json"], {
      cwd: repo,
      env,
      timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    return Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(result.stdout);
  };
  const daemonPid = async () => {
    const result = await execute(bun, [entry, "doctor", "--json"], {
      cwd: repo,
      env,
      timeout: 10_000,
    });
    const diagnostic = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorResult))(result.stdout);
    if (diagnostic.daemon.state !== "running") throw new Error("Daemon did not return");
    pids.add(diagnostic.daemon.pid);
    return diagnostic.daemon.pid;
  };
  const captureFakePids = async () => {
    for (const value of (await readFile(fakePids, "utf8")).trim().split("\n").filter(Boolean))
      pids.add(Number(value));
  };
  const captureLockOwner = async () => {
    try {
      const owner = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonLockOwner))(
        await readFile(`${data}/daemon.lock`, "utf8"),
      );
      pids.add(owner.pid);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
  const consistent = async () => {
    const status = await run(["status"]);
    if (status._tag !== "Digests") throw new Error("Expected status digests");
    expect(status.digests.map((digest) => digest.name).sort()).toEqual([...expectedNames].sort());
    for (const name of expectedNames) {
      const record = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord))(
        await readFile(`${data}/runs/${name}/run.json`, "utf8"),
      );
      expect(record.name).toBe(name);
      expect(["lost", "idle", "failed", "unknown"]).toContain(record.state);
      const digest = status.digests.find((digest) => digest.name === name);
      if (!digest) throw new Error(`Status dropped ${name}`);
      expect(["lost", "idle", "failed", "unknown"]).toContain(digest.state);
      if (digest.state === "unknown")
        expect(digest.failure?.message || digest.warnings.join(" ")).toBeTruthy();
      for (const [file, schema] of [
        ["events.jsonl", RunEvent],
        ["questions.jsonl", QuestionLine],
      ] as const) {
        const text = await readFile(`${data}/runs/${digest.name}/${file}`, "utf8");
        expect(text === "" || text.endsWith("\n")).toBe(true);
        for (const line of text.trim().split("\n").filter(Boolean))
          Schema.decodeUnknownSync(Schema.fromJsonString(schema))(line);
      }
    }
    expect(await run(["wait", "--all", "--timeout", "0ms"])).toMatchObject({ _tag: "Waited" });
  };
  try {
    // Start one daemon before racing clients, then exercise three simultaneous starts.
    await run(["status"]);
    for (let iteration = 0; iteration < 4; iteration++) {
      const names = Array.from({ length: 3 }, (_, index) => `stress-${iteration}-${index}`);
      const starts = await Promise.allSettled(
        names.map((name) =>
          run([
            "start",
            name,
            "--new-worktree",
            "--contract",
            `${root}/contract.md`,
            "--model",
            "test",
          ]),
        ),
      );
      for (const result of starts) {
        expect(result.status).toBe("fulfilled");
        if (result.status === "rejected") throw result.reason;
      }
      for (const name of names) expectedNames.add(name);
      await run(["wait", "--all", "--timeout", "1s"]);
      const pid = await daemonPid();
      await captureFakePids();
      const target = names[next() % names.length];
      if (!target) throw new Error("Missing seeded target");
      if ((next() >>> 16) % 2 === 0) {
        // A protocol request makes the fake exit, while all three runs own turns.
        await run(["interrupt", target]);
        await run(["wait", "--all", "--timeout", "1s"]);
        await consistent();
      }
      process.kill(pid, "SIGKILL");
      await exited(pid);
      await consistent();
      expect(await daemonPid()).not.toBe(pid);
      // Even when the seed chooses daemon-first, exercise a scripted app-server exit.
      const trigger = `exit-${iteration}`;
      await run([
        "start",
        trigger,
        "--new-worktree",
        "--contract",
        `${root}/contract.md`,
        "--model",
        "test",
      ]);
      expectedNames.add(trigger);
      await run(["interrupt", trigger]);
      await run(["wait", "--all", "--timeout", "1s"]);
      await consistent();
    }
  } finally {
    await captureLockOwner();
    await captureFakePids();
    try {
      await execute(bun, [entry, "daemon", "stop"], { cwd: repo, env, timeout: 5000 });
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      await Promise.all([...pids].map(exited));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 59_000);
