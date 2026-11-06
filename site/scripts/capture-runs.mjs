#!/usr/bin/env node
// Export forman run records into scrubbed fixtures the page replays.
//
//   node scripts/capture-runs.mjs <run-name>...
//
// Reads $FORMAN_HOME/runs/<name>/ (default ~/.forman) and writes
// fixtures/runs/<name>.json. It also captures `forman status <name>` as the
// digest. Home paths, the worktree prefix and temp directories are scrubbed;
// the output is reviewed by hand before committing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const home = process.env.FORMAN_HOME ?? join(homedir(), ".forman");
const outDir = new URL("../fixtures/runs/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const TAIL_LINES = 4;
const TAIL_CHARS = 400;

// Event paths are shown relative to the delegate's worktree; the digest keeps
// full paths, with the repository shown as ~/src/forman.
function scrubber(run, { relative = true } = {}) {
  const worktree = run.worktree.endsWith("/")
    ? run.worktree
    : `${run.worktree}/`;
  const user = homedir();
  return (text) => {
    let out = text;
    if (relative)
      out = out.replaceAll(worktree, "").replaceAll(run.worktree, ".");
    return out
      .replaceAll(run.group, "~/src/forman")
      .replace(/\/private\/tmp\/claude-[^\s'"`)]*/g, "/tmp/scratch")
      .replace(/\/var\/folders\/[^\s'"`)]*/g, "/tmp/scratch")
      .replaceAll(user, "~")
      .replace(new RegExp(`\\b${userInfo().username}\\b`, "g"), "dev");
  };
}

// Codex wraps every command as `/bin/zsh -lc '<cmd>'` (or unquoted when simple).
function unwrapShell(command) {
  const m = /^\/bin\/(?:ba|z)?sh -lc (.*)$/s.exec(command);
  if (!m) return command;
  const body = m[1];
  if (body.startsWith("'") && body.endsWith("'")) {
    return body.slice(1, -1).replaceAll("'\"'\"'", "'");
  }
  if (body.startsWith('"') && body.endsWith('"')) return body.slice(1, -1);
  return body;
}

function tail(text) {
  if (!text) return "";
  const lines = text
    .replace(/\s+$/, "")
    .split("\n")
    .slice(-TAIL_LINES)
    .join("\n");
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function exportRun(name) {
  const dir = join(home, "runs", name);
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  const scrub = scrubber(run);
  const start = Date.parse(run.createdAt);
  const at = (iso) => Date.parse(iso) - start;

  const events = [];
  let tokens = null;
  for (const { seq, at: iso, event } of readJsonl(join(dir, "events.jsonl"))) {
    const t = at(iso);
    switch (event._tag) {
      case "StateChanged":
        events.push({ seq, t, kind: "state", from: event.from, to: event.to });
        break;
      case "TurnStarted":
        events.push({
          seq,
          t,
          kind: "turn-started",
          turn: event.turn,
          turnKind: event.kind,
        });
        break;
      case "TurnCompleted":
        events.push({
          seq,
          t,
          kind: "turn-completed",
          turn: event.turn,
          status: event.status,
        });
        break;
      case "AgentMessage":
        events.push({
          seq,
          t,
          kind: "message",
          text: scrub(event.text.trim()),
        });
        break;
      case "Command":
        events.push({
          seq,
          t,
          kind: "command",
          command: scrub(unwrapShell(event.command)),
          exitCode: event.exitCode ?? null,
          output: scrub(tail(event.outputTail)),
        });
        break;
      case "FileChange":
        events.push({ seq, t, kind: "files", paths: event.paths.map(scrub) });
        break;
      case "QuestionAsked":
        events.push({
          seq,
          t,
          kind: "question",
          id: event.id,
          text: scrub(event.question),
        });
        break;
      case "QuestionResolved":
        events.push({
          seq,
          t,
          kind: "question-resolved",
          id: event.id,
          resolution: event.resolution,
        });
        break;
      case "HookBlocked":
        events.push({
          seq,
          t,
          kind: "hook-blocked",
          feedback: scrub(event.feedback),
        });
        break;
      case "TokenUsage":
        tokens = event.totals;
        break;
      default:
        break;
    }
  }

  const questions = readJsonl(join(dir, "questions.jsonl")).map((q) => ({
    ...q,
    t: at(q.at),
    ...(q.question ? { question: scrub(q.question) } : {}),
    ...(q.text ? { text: scrub(q.text) } : {}),
  }));

  const handoffPath = join(dir, "turns", "1.md");
  const digest = execFileSync("forman", ["status", name], { encoding: "utf8" });

  const fixture = {
    name,
    model: run.model,
    effort: run.effort,
    tier: run.tier,
    write: run.sandbox === "danger-full-access",
    branch: run.managedWorktree?.branch ?? null,
    baseCommit: run.baseCommit.slice(0, 7),
    createdAt: run.createdAt,
    durationMs: Date.parse(run.updatedAt) - start,
    tokens: tokens ?? run.tokens,
    contract: scrub(readFileSync(join(dir, "contract.md"), "utf8")),
    events,
    questions,
    handoff: existsSync(handoffPath)
      ? scrub(readFileSync(handoffPath, "utf8"))
      : null,
    digest: scrubber(run, { relative: false })(digest),
  };
  const out = new URL(`${name}.json`, outDir);
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${name}: ${events.length} events -> fixtures/runs/${name}.json`);
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: node scripts/capture-runs.mjs <run-name>...");
  process.exit(2);
}
for (const name of names) exportRun(name);
