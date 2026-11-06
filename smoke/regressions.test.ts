import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { cleanupFixture } from "./cleanup";
import { fixture, nextCommand } from "./helpers";

const enabled = process.env.FORMAN_SMOKE === "1";
const regression = test.skipIf(!enabled);
if (!enabled) console.log("Harness regressions skipped: enable with FORMAN_SMOKE=1 bun run smoke");
const proxy = resolve(import.meta.dir, "codex-proxy.ts");
regression("continuations accept shell-quoted executable paths", () => {
  expect(
    nextCommand(
      "next: '/tmp/build path'\\''s/forman' wait smoke --after cursor",
      "/tmp/build path's/forman",
    ),
  ).toEqual(["wait", "smoke", "--after", "cursor"]);
});
regression("continuations accept a quoted home assignment before the executable", () => {
  expect(
    nextCommand(
      "next: FORMAN_HOME='/tmp/home path' '/tmp/build path/forman' wait smoke --after cursor",
      "/tmp/build path/forman",
    ),
  ).toEqual(["wait", "smoke", "--after", "cursor"]);
});

regression("proxy exits quietly when its stdout consumer closes the pipe", async () => {
  const root = await mkdtemp("/tmp/fm-reg-");
  const script = join(root, "output.mjs");
  await writeFile(
    script,
    `process.stdout.on("error", e => { if (e.code !== "EPIPE") throw e; });\nfunction write() { if (process.stdout.write(Buffer.alloc(65536, 120))) setImmediate(write); else process.stdout.once("drain", write); }\nwrite();`,
  );
  const child = spawn(proxy, [script], {
    env: { ...process.env, SMOKE_CODEX_BIN: process.execPath, SMOKE_WIRE: join(root, "wire") },
    stdio: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  const closed = once(child, "close", { signal: AbortSignal.timeout(4000) });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await once(child.stdout, "data");
    child.stdout.destroy();
    expect(await closed).toEqual([0, null]);
    expect(stderr).toBe("");
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

regression("proxy drains output when Codex closes its input pipe", async () => {
  const root = await mkdtemp("/tmp/fm-reg-");
  const script = join(root, "closed-input");
  const wire = join(root, "wire");
  await writeFile(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
fs.closeSync(0);
process.on("SIGUSR1", () => {
  process.stdout.write("FINISHED\\n", () => process.exit(0));
});
process.stdout.write("READY:" + process.pid + "\\n");
process.stdin.pause();
const keepAlive = require("node:net").createServer();
keepAlive.listen(0);
`,
    { mode: 0o755 },
  );
  const child = spawn(proxy, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, SMOKE_CODEX_BIN: script, SMOKE_WIRE: wire },
    stdio: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  const closed = once(child, "close", { signal: AbortSignal.timeout(4000) });
  let stdout = "";
  let stderr = "";
  let codexPid: number | undefined;
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const [ready] = await once(child.stdout, "data");
    const pid = Schema.decodeUnknownSync(Schema.NumberFromString)(
      ready.toString().trim().split(":")[1],
    );
    codexPid = pid;
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
    child.stdin.write(Buffer.alloc(1024 * 1024, 120));
    while (
      (
        await readFile(`${wire}.in`, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      ).length === 0
    ) {}
    process.kill(pid, "SIGUSR1");
    expect(await closed).toEqual([0, null]);
    expect(stdout).toBe(`READY:${pid}\nFINISHED\n`);
    expect(stderr).toBe("");
  } finally {
    child.kill("SIGKILL");
    if (codexPid !== undefined && exists(codexPid)) process.kill(codexPid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

regression("proxy drains inherited stdout after the child exits", async () => {
  const root = await mkdtemp("/tmp/fm-reg-");
  try {
    const script = join(root, "output.mjs");
    const size = 16 * 1024 * 1024;
    const tail = join(root, "tail.mjs");
    await writeFile(
      tail,
      `await new Promise((done) => process.stdout.write(Buffer.alloc(${size}, 120), () => done()));`,
    );
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(tail)}], { stdio: ["ignore", "inherit", "inherit"] });
process.exit(0);`,
    );
    const child = Bun.spawn([proxy, script], {
      env: { ...process.env, SMOKE_CODEX_BIN: "node", SMOKE_WIRE: join(root, "wire") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output.byteLength).toBe(size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

regression("proxy forwards SIGTERM and exits while its stdin remains open", async () => {
  const root = await mkdtemp("/tmp/fm-reg-");
  try {
    const script = join(root, "held.ts");
    await writeFile(script, 'process.stdout.write("READY\\n"); process.stdin.resume();');
    const child = Bun.spawn([proxy, script], {
      env: { ...process.env, SMOKE_CODEX_BIN: process.execPath, SMOKE_WIRE: join(root, "wire") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2500,
      killSignal: "SIGKILL",
    });
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("READY\n");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stderr).text()).toBe("");
    await reader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

regression("failed shutdown terminates the owned process tree before removing state", async () => {
  const root = await mkdtemp("/tmp/fm-reg-");
  const script = join(root, "tree.ts");
  await writeFile(
    script,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "inherit"] });
child.on("spawn", () => process.stdout.write(JSON.stringify({ pid: child.pid }) + "\\n"));
process.stdin.resume();`,
  );
  const child = Bun.spawn([process.execPath, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const ready = Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Int }))(
    JSON.parse(new TextDecoder().decode((await reader.read()).value)),
  );
  try {
    await expect(
      cleanupFixture(root, child.pid, async () => {
        throw new Error("daemon stop refused");
      }),
    ).rejects.toThrow("daemon stop refused");
    expect(exists(child.pid)).toBe(false);
    expect(exists(ready.pid)).toBe(false);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    for (const pid of [child.pid, ready.pid]) if (exists(pid)) process.kill(pid, "SIGKILL");
    await child.exited;
    await reader.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

regression("scratch Git ignores signing config and inherited repository selectors", async () => {
  const root = await mkdtemp("/tmp/fm-reg-");
  const config = join(root, "gitconfig");
  await writeFile(config, "[commit]\n  gpgsign = true\n[gpg]\n  program = /does-not-exist\n");
  try {
    const f = await fixture({
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_DIR: join(root, "wrong.git"),
      GIT_WORK_TREE: root,
    });
    try {
      const head = execFileSync("git", ["-C", f.worktree, "rev-parse", "--show-toplevel"], {
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        encoding: "utf8",
      });
      expect(head.trim()).toBe(await realpath(f.worktree));
      expect(await readFile(join(f.worktree, ".git"), "utf8")).toContain("gitdir:");
    } finally {
      await f.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
