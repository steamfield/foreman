// Codex PreToolUse (apply_patch): hand Codex the Claude Code rules in .claude/rules/ that cover
// the files a patch touches, the way Claude Code attaches them by `paths:`. Codex has no
// path-scoped instructions of its own, so without this a delegate either misses the rules or
// reads all of them up front. A rule without `paths:` applies to every file, as in Claude Code.
//
// Each rule is sent once per Codex session; the session's sent list lives under the temp
// directory, and `--reset` (wired to PostCompact) clears it so rules a compaction summarized
// away are sent again. Context from PreToolUse reaches the model alongside the patch, so the
// first edit to a covered file is made before its rule arrives; the preface asks Codex to
// re-check it.
//
// Runs under Bun (TypeScript, and Bun's matchesGlob, which unlike Node's matches dotfiles).
// Self-contained, with no project imports, so another repo can copy it.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";

// Codex's default additionalContextLimit is 2,500 tokens; stay under it so nothing is cut off.
const BUDGET_CHARS = 8000;

type Rule = { path: string; globs: string[] | undefined; body: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readInput(): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(readFileSync(0, "utf8")));
  } catch {
    // No usable payload: add nothing and let the patch through.
    return undefined;
  }
}

/** `path` with symlinks resolved, through its nearest existing ancestor when it doesn't exist yet. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

function inside(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** The repo-relative paths a patch adds, updates or moves to. Deleted files get no rules. */
function patchedPaths(patch: string, root: string, cwd: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/.exec(line.replace(/\r$/, ""));
    if (!match?.[1]) continue;
    const file = match[1].trim();
    const rel = relative(root, real(isAbsolute(file) ? file : resolve(cwd, file)));
    if (inside(rel)) paths.add(rel);
  }
  return [...paths];
}

function markdownFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    try {
      // statSync follows symlinks, so shared rules linked into the tree count.
      const stat = statSync(path);
      if (stat.isDirectory()) return markdownFiles(path);
      return stat.isFile() && name.endsWith(".md") ? [path] : [];
    } catch {
      // A dangling link or an unreadable entry: skip it, keep the rest.
      return [];
    }
  });
}

function unquote(value: string): string {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  return trimmed.replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** `paths:` globs: undefined without the key (a global rule), empty when the key holds none. */
function parseGlobs(front: string): string[] | undefined {
  const lines = front.split("\n");
  const start = lines.findIndex((line) => /^paths:/.test(line));
  if (start === -1) return undefined;
  const inline = unquote((lines[start] ?? "").slice("paths:".length));
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter(Boolean);
  }
  if (inline) return [inline];
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item?.[1]) {
      const glob = unquote(item[1]);
      if (glob) globs.push(glob);
    } else if (line.trim() && !/^\s/.test(line)) break;
  }
  return globs;
}

/** Markdown link targets rewritten from rule-relative to repo-relative paths. */
function repoLinks(body: string, ruleFile: string, root: string): string {
  return body.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return whole;
    const [path = "", fragment] = target.split("#");
    const rel = relative(root, resolve(dirname(ruleFile), path));
    return `](${rel}${fragment === undefined ? "" : `#${fragment}`})`;
  });
}

function readRule(file: string, root: string): Rule | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    // An unreadable rule: skip it, keep the rest.
    return undefined;
  }
  const path = relative(root, file);
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  const body = repoLinks((front ? text.slice(front[0].length) : text).trim(), file, root);
  return { path, globs: front?.[1] === undefined ? undefined : parseGlobs(front[1]), body };
}

function sentFile(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(tmpdir(), "codex-rules", digest);
}

function readSent(file: string | undefined): Set<string> {
  if (!file) return new Set();
  try {
    return new Set(readFileSync(file, "utf8").split("\n").filter(Boolean));
  } catch {
    // Nothing sent yet in this session.
    return new Set();
  }
}

function recordSent(file: string | undefined, sent: Set<string>): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${[...sent].join("\n")}\n`);
  } catch {
    // Unwritable temp dir: the rules may be sent again on a later patch, which is only noise.
  }
}

function sections(root: string, files: string[], sent: Set<string>): string[] {
  const out: string[] = [];
  let used = 0;
  for (const file of markdownFiles(join(root, ".claude", "rules")).sort()) {
    const rel = relative(root, file);
    if (sent.has(rel)) continue;
    const rule = readRule(file, root);
    if (!rule?.body || rule.globs?.length === 0) continue;
    const covered = rule.globs
      ? files.filter((path) => rule.globs?.some((glob) => matchesGlob(path, glob)))
      : files;
    if (covered.length === 0) continue;
    const head = `Project rule ${rel} applies to ${covered.join(", ")}.`;
    let section = `${head}\n\n${rule.body}`;
    if (section.length > BUDGET_CHARS)
      section = `${head} It is too long to include here: read ${rel}.`;
    // Over budget: leave the rule unsent so a later patch carries it.
    if (used + section.length > BUDGET_CHARS) continue;
    used += section.length;
    sent.add(rel);
    out.push(section);
  }
  return out;
}

const input = readInput();
const sessionId = str(input?.session_id);
const state = sessionId ? sentFile(sessionId) : undefined;

if (process.argv.includes("--reset")) {
  if (state) rmSync(state, { force: true });
} else {
  const patch = str(record(input?.tool_input)?.command);
  const cwd = real(str(input?.cwd) || process.cwd());
  const root = real(process.argv[2] ?? cwd);
  const files = patchedPaths(patch, root, cwd);
  const sent = readSent(state);
  const found = files.length > 0 ? sections(root, files, sent) : [];
  if (found.length > 0) {
    recordSent(state, sent);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `Project rules for the files in this patch. The patch is being applied as written; check it against these rules and fix anything they rule out.\n\n${found.join("\n\n---\n\n")}`,
        },
      })}\n`,
    );
  }
}
