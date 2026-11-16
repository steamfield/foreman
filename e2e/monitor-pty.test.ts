import { expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
        if (!quitSent && output.includes("Saved state · daemon not running")) {
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
