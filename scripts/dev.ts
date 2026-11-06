#!/usr/bin/env bun
// `bun run dev -- <args>`: forman from source, the way a person or agent runs it while working
// here. Adds what the installed binary doesn't do:
//   - LOG_LEVEL defaults to info (the binary's default is warn), so each run logs its
//     command records.
//   - JSON log lines go to logs/cli.jsonl (FORMAN_LOG_FILE), appended across runs.
//   - stderr is copied to logs/cli.log. Both files move to *.prev.* past 5 MB.
//   - Development config and data are saved in .dev/home (FORMAN_HOME).
// Everything else (stdin, stdout, the exit code, Ctrl+C) passes straight through.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const logs = join(root, "logs");
mkdirSync(logs, { recursive: true });

const rotate = (file: string, prev: string) => {
  if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, prev);
};
rotate(join(logs, "cli.jsonl"), join(logs, "cli.prev.jsonl"));
rotate(join(logs, "cli.log"), join(logs, "cli.prev.log"));

const args = process.argv.slice(2);
// Preserve terminal capabilities for interactive invocations; structured logs remain on disk.
const interactive = process.stdin.isTTY && process.stdout.isTTY;
const logFileKey = "FORMAN_LOG_FILE";
const homeKey = "FORMAN_HOME";

const child = Bun.spawn([process.execPath, join(root, "src/bin.ts"), ...args], {
  env: {
    ...process.env,
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    [logFileKey]: process.env[logFileKey] ?? join(logs, "cli.jsonl"),
    [homeKey]: process.env[homeKey]?.trim() ? process.env[homeKey] : join(root, ".dev", "home"),
    // Colors survive the pipe when the real stderr is a terminal.
    ...(process.stderr.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: "1" } : {}),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: interactive ? "inherit" : "pipe",
});

// Ctrl+C reaches the child through the terminal's process group; wait for its exit code.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));

if (child.stderr) {
  const logFile = join(logs, "cli.log");
  const decoder = new TextDecoder();
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  for await (const chunk of child.stderr) {
    process.stderr.write(chunk);
    // Plain text in the file, like logs/cli.jsonl's fields.
    appendFileSync(logFile, decoder.decode(chunk, { stream: true }).replace(ansi, ""));
  }
}
process.exit(await child.exited);
