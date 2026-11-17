import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

async function savedRun(home: string, name: string, state: "waiting" | "idle") {
  const dir = join(home, "runs", name);
  const at = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      formatVersion: 1,
      name,
      threadId: null,
      group: "/repo",
      worktree: `/repo/work/${name}`,
      baseCommit: "base",
      model: "gpt-6.1-sol",
      effort: "high",
      tier: "priority",
      sandbox: "read-only",
      questionTimeoutMs: 900000,
      state,
      turns: 1,
      turnKind: "start",
      activeTurnId: null,
      turnBudgetMs: null,
      turnStartedAt: null,
      restoreSandbox: false,
      tokens: null,
      failure: null,
      warnings: [],
      createdAt: at,
      updatedAt: at,
    }),
  );
  await writeFile(join(dir, "contract.md"), `# Inspect ${name} task\nRead the saved journals.`);
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({
      formatVersion: 1,
      seq: 1,
      at,
      event: { _tag: "AgentMessage", text: `${name} journal message`, phase: "commentary" },
    })}\n`,
  );
  if (state === "waiting")
    await writeFile(
      join(dir, "questions.jsonl"),
      `${JSON.stringify({
        formatVersion: 1,
        _tag: "Asked",
        id: "q1",
        turn: 1,
        kind: "question",
        question: "Continue?",
        at,
      })}\n`,
    );
}

test("compiled monitor paints saved state in a PTY and quits without starting a daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "fm-pty-"));
  const home = join(root, "data");
  let output = "";
  let quitSent = false;
  const decoder = new TextDecoder();
  let closeTerminal = () => {};
  const closed = new Promise<void>((resolve) => {
    closeTerminal = resolve;
  });
  const child = Bun.spawn([resolve("dist/foreman"), "monitor"], {
    cwd: root,
    env: {
      HOME: root,
      FOREMAN_HOME: home,
      LOG_LEVEL: "none",
      NO_COLOR: "1",
      TERM: "xterm-256color",
    },
    timeout: 10000,
    terminal: {
      cols: 100,
      rows: 24,
      data(terminal, bytes) {
        output += decoder.decode(bytes, { stream: true });
        if (!quitSent && output.includes("No runs on this machine yet.")) {
          quitSent = true;
          terminal.write("q");
        }
      },
      exit: () => closeTerminal(),
    },
  });
  try {
    const [status] = await Promise.all([child.exited, closed]);
    expect(status, output).toBe(0);
    expect(quitSent, output).toBe(true);
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1049l");
    expect(output).not.toContain("Internal error.");
    await expect(lstat(join(home, "foreman.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    child.kill();
    await child.exited;
    child.terminal?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("compiled monitor handles selection, panes, follow, help and filtering through raw keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "fm-keys-"));
  const home = join(root, "data");
  await savedRun(home, "unit", "waiting");
  await savedRun(home, "finished", "idle");
  let output = "";
  const decoder = new TextDecoder();
  const listeners = new Set<() => void>();
  let closeTerminal = () => {};
  const closed = new Promise<void>((resolve) => {
    closeTerminal = resolve;
  });
  const child = Bun.spawn([resolve("dist/foreman"), "monitor"], {
    cwd: root,
    env: {
      HOME: root,
      FOREMAN_HOME: home,
      LOG_LEVEL: "none",
      FORCE_COLOR: "3",
      TERM: "xterm-256color",
    },
    timeout: 10000,
    terminal: {
      cols: 100,
      rows: 40,
      data(_terminal, bytes) {
        output += decoder.decode(bytes, { stream: true });
        for (const notify of listeners) notify();
      },
      exit: () => closeTerminal(),
    },
  });
  const waitFor = (predicate: (raw: string, text: string) => boolean, after = 0) =>
    Promise.race([
      new Promise<void>((resolve) => {
        const notify = () => {
          const raw = output.slice(after);
          if (!raw.endsWith("\u001b[?2026l") || !predicate(raw, stripVTControlCharacters(raw)))
            return;
          listeners.delete(notify);
          resolve();
        };
        listeners.add(notify);
        notify();
      }),
      child.exited.then((status) => {
        throw new Error(`Exited ${status} waiting for a frame:\n${output}`);
      }),
    ]);
  const key = (value: string) => {
    const after = output.length;
    child.terminal?.write(value);
    return after;
  };
  try {
    await waitFor(
      (_raw, text) =>
        text.includes("Saved state · daemon not running") && text.includes("finished"),
    );
    const selected = key("j");
    await waitFor((raw) => /48;2;27;30;26m[^\n]*unit/.test(raw), selected);
    await waitFor(
      (_raw, text) => text.includes("Task") && text.includes("Inspect unit task"),
      key("\r"),
    );
    for (const pane of [
      "Digest",
      "Questions",
      "Subagents",
      "Hand-off",
      "Commands",
      "Files",
      "Feed",
    ]) {
      await waitFor((raw) => raw.includes(`38;2;228;232;224m╭─ \u001b[1m${pane}`), key("\t"));
    }
    expect(stripVTControlCharacters(output)).toContain("unit journal message");
    await waitFor((_raw, text) => text.includes("paused · f to follow"), key("f"));
    await waitFor((_raw, text) => text.includes("needs me"), key("\u001b"));
    await waitFor((_raw, text) => text.includes("Monitor help"), key("?"));
    await waitFor((_raw, text) => text.includes("finished"), key("?"));
    await waitFor((_raw, text) => text.includes("runs"), key("!"));
    // Resize requests a complete frame after Ink's incremental footer update.
    const resized = output.length;
    child.terminal?.resize(101, 40);
    await waitFor((_raw, text) => text.includes("! all runs"), resized);
    const filtered = stripVTControlCharacters(output.slice(resized));
    expect(filtered).toContain("unit");
    expect(filtered).not.toContain("finished");
    key("q");
    const [status] = await Promise.all([child.exited, closed]);
    expect(status, output).toBe(0);
    expect(output.split("\x1b[?1049l")).toHaveLength(2);
    expect(output).not.toContain("Internal error.");
    await expect(lstat(join(home, "foreman.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    child.kill();
    await child.exited;
    child.terminal?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
