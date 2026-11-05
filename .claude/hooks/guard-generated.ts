// PreToolUse (Edit|Write): deny hand edits to files a tool generates. Editing them by hand is
// lost on the next run and hides the real fix.
//
//   dist/                        build output (the project build command)
//   coverage/                    coverage reports (bun run coverage)
//   bun.lock                     bun's lockfile (bun add / bun remove / bun install)
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { deny, readPayload, text } from "./_lib";

function root(): string {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : process.cwd();
}

function physical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function reasonFor(filePath: string): string | undefined {
  // The root as given and with symlinks resolved (/tmp vs /private/tmp), each without a trailing
  // slash, so neither can route a generated file around the guard.
  const given = root().replace(/\/+$/, "");
  const dirs = [given, physical(given || "/").replace(/\/+$/, "")];
  const dir = dirs.find((d) => filePath.startsWith(`${d}/`));
  let rel = filePath;
  if (dir !== undefined) rel = filePath.slice(dir.length + 1);
  else if (filePath.startsWith("/")) return undefined;

  if (rel.startsWith("dist/") || rel.startsWith("build/")) {
    return `${rel} is build output. Change the source and run the project build command.`;
  }
  if (rel.startsWith("coverage/")) {
    return `${rel} is a coverage report. Run bun run coverage to regenerate it.`;
  }
  if (rel === "bun.lock") {
    return "bun.lock is written by bun. Change package.json with bun add / bun remove, or run bun install.";
  }

  return undefined;
}

const filePath = text(readPayload()?.tool_input?.file_path);
const reason = filePath ? reasonFor(filePath) : undefined;
if (reason) deny(`BLOCKED: ${reason}`);
