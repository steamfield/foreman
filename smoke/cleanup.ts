import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function descendants(pid: number) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) throw new Error(`Invalid process row: ${line}`);
      return { pid: Number(match[1]), parent: Number(match[2]) };
    });
  const owned = new Set([pid]);
  for (const parent of owned) for (const row of rows) if (row.parent === parent) owned.add(row.pid);
  return [...owned].reverse();
}

function waitForExit(pids: number[]) {
  return new Promise<boolean>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const timer = setInterval(() => {
      try {
        if (pids.every((pid) => !alive(pid))) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          resolve(false);
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 25);
  });
}

function signal(pids: number[], value: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, value);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

export async function cleanupFixture(
  root: string,
  pid: number | undefined,
  stop: () => Promise<void>,
) {
  // Snapshot before stop can reparent descendants. The PID comes from this fixture's daemon.
  const owned = pid === undefined ? [] : descendants(pid);
  const failures: unknown[] = [];
  try {
    await stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length && pid === undefined)
    throw new AggregateError(failures, `Daemon identity unavailable; retained ${root}`);
  if (failures.length || !(await waitForExit(owned))) {
    signal(owned, "SIGTERM");
    if (!(await waitForExit(owned))) {
      signal(owned, "SIGKILL");
      if (!(await waitForExit(owned)))
        throw new AggregateError(failures, `Fixture processes still alive; retained ${root}`);
    }
  }
  await rm(root, { recursive: true, force: true });
  if (failures.length)
    throw new AggregateError(failures, "daemon stop refused; forced cleanup completed");
}
