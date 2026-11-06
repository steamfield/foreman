import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { cleanupFixture } from "./cleanup";
import { fixture } from "./helpers";

const enabled = process.env.FORMAN_SMOKE === "1";
const regression = test.skipIf(!enabled);
if (!enabled) console.log("Harness regressions skipped: enable with FORMAN_SMOKE=1 bun run smoke");
const proxy = resolve(import.meta.dir, "codex-proxy.ts");
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
    const child = Bun.spawn([process.execPath, proxy, script], {
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
    const child = Bun.spawn([process.execPath, proxy, script], {
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
