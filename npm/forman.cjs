#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { constants } = require("node:os");

const target = `${process.platform}-${process.arch}`;
const packageName = `@steamfield/forman-${target}`;
const supported = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
if (!supported.includes(target)) {
  console.error(`forman: unsupported platform ${target}; no binary package ${packageName} is available.`);
  process.exit(1);
}

let binary;
try {
  binary = require.resolve(`${packageName}/bin/forman`);
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  console.error(
    `forman: missing binary package ${packageName}. Reinstall @steamfield/forman with optional dependencies enabled.`,
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
const forward = (signal) => child.kill(signal);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);
process.on("SIGHUP", forward);
child.on("error", (error) => {
  console.error(`forman: could not run ${packageName}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);
  process.off("SIGHUP", forward);
  if (signal) {
    // Node ignores some signals, so retain a failing status if re-emitting it returns.
    process.exitCode = 128 + constants.signals[signal];
    process.kill(process.pid, signal);
  } else process.exitCode = code ?? 1;
});
