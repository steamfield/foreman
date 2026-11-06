#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const executable = process.env.SMOKE_CODEX_BIN;
const wire = process.env.SMOKE_WIRE;
if (!executable || !wire) throw new Error("Smoke proxy requires SMOKE_CODEX_BIN and SMOKE_WIRE");
const args = process.argv.slice(2);
const child = spawn(executable, args, { stdio: ["pipe", "pipe", "inherit"] });
if (args[0] === "app-server" && args.includes("--listen")) {
  process.stdin.on("data", (chunk: Buffer) => appendFileSync(`${wire}.in`, chunk));
  child.stdout.on("data", (chunk: Buffer) => appendFileSync(`${wire}.out`, chunk));
}
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (code, signal) => {
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  const finish = () =>
    process.stdout.end(() => {
      if (signal) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } else process.exit(code ?? 1);
    });
  if (child.stdout.readableEnded) finish();
  else child.stdout.once("end", finish);
});
