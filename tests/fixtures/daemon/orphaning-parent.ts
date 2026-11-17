// Starts the daemon fixture in its own process group, waits for it to become ready, prints its
// pid and exits, leaving the fixture orphaned the way a crashed test run would.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const [dataDir] = process.argv.slice(2);
if (dataDir === undefined) throw new Error("data directory required");
const child = spawn(
  process.execPath,
  [new URL("./entry.ts", import.meta.url).pathname, dataDir, "test"],
  { detached: true, stdio: "ignore" },
);
child.unref();
const deadline = Date.now() + 5000;
const poll = setInterval(() => {
  if (existsSync(`${dataDir}/ready`)) {
    clearInterval(poll);
    process.stdout.write(`${child.pid}\n`);
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    child.kill("SIGKILL");
    throw new Error(`fixture in ${dataDir} was not ready within 5 seconds`);
  }
}, 20);
