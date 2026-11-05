// SessionStart: live state for this stack that AGENTS.md can't carry because it is static:
// the installed Bun version and how many
// warn/error lines logs/cli.jsonl gained since the previous session started.
//
// Plain-text stdout from a SessionStart hook is added to the agent's context. Separate from the
// agent-ops session-start hook (branch, dirty files, .env, dependencies), which stays
// stack-neutral. Cheap: a few file checks and one ps call.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { projectRoot, readPayload } from "./_lib";

readPayload(); // Unused, but read so the writer never blocks on a full pipe.

const lines: string[] = [];
const say = (line: string) => lines.push(line);

// `bun run` resolves to whatever bun is on PATH, and bun doesn't enforce `packageManager`, so a
// different version builds and tests against a runtime CI doesn't use. This hook runs under that
// same bun.
function bunVersion(): void {
  if (!existsSync("package.json")) return;
  let pinned: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { packageManager?: unknown };
    pinned = typeof pkg.packageManager === "string" ? pkg.packageManager : undefined;
  } catch {
    return;
  }
  const wanted = pinned?.startsWith("bun@") ? pinned.slice(4) : undefined;
  const running = process.versions.bun;
  if (!wanted || !running || wanted === running) return;
  say(
    `bun ${running} is on PATH, but package.json pins bun@${wanted} (packageManager), which CI and the release builds use. Ask the user before running \`bun upgrade\` (it changes their machine); until then, a difference between local and CI results may be the runtime.`,
  );
}

// `bun run dev -- <args>` appends JSON log lines to logs/cli.jsonl. Problems since the last
// session are worth reading before guessing; older ones were reported then. The byte offset read
// up to is kept under $TMPDIR/project-status/, keyed by the repo root, with the file's inode and
// first bytes: when either changes (scripts/dev.ts rotated the log, or it was deleted and
// recreated) or the file shrank, it is read from the start again.
type LogMark = { ino: number; head: string; offset: number };

function readBytes(file: string, start: number, length: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function cliLog(root: string): void {
  const file = "logs/cli.jsonl";
  if (!existsSync(file)) return;
  const dir = join((process.env.TMPDIR || "/tmp").replace(/\/$/, ""), "project-status");
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const markFile = join(dir, `cli-log-${key}.json`);

  const { ino, size } = statSync(file);
  const head = readBytes(file, 0, Math.min(size, 256)).toString("latin1");
  let start = 0;
  try {
    const mark = JSON.parse(readFileSync(markFile, "utf8")) as Partial<LogMark>;
    const same = mark.ino === ino && typeof mark.head === "string" && head.startsWith(mark.head);
    if (same && typeof mark.offset === "number" && mark.offset <= size) start = mark.offset;
  } catch {
    // No mark yet (the first session in this checkout) or an unreadable one: count from the start.
  }

  const added = readBytes(file, start, size - start);
  // Only whole lines: one still being written is counted next time.
  const end = added.lastIndexOf(0x0a) + 1;
  const problems = added
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .filter((line) => /"level":"(warn|error|fatal)"/.test(line)).length;
  try {
    mkdirSync(dir, { recursive: true });
    const mark: LogMark = { ino, head, offset: start + end };
    writeFileSync(markFile, JSON.stringify(mark));
  } catch {
    // An unwritable TMPDIR: the next session counts these lines again, which is only noise.
  }
  if (problems === 0) return;
  const query = `jq -c 'select(.level == "warn" or .level == "error" or .level == "fatal")'`;
  say(
    start === 0
      ? `${file} has ${problems} warn/error line(s): ${query} ${file}`
      : `${file} has ${problems} new warn/error line(s) since the last session started: tail -c +${start + 1} ${file} | ${query}`,
  );
}

const root = projectRoot();
try {
  process.chdir(root);
} catch {
  process.exit(0);
}
bunVersion();
cliLog(root);
if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
