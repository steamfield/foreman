import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../helpers/hooks";

// The commands .codex/hooks.json wires, run the way Codex runs them: through a shell from the
// session cwd, with the payload on stdin.
type Group = { matcher?: string; hooks: { command: string }[] };
const config = JSON.parse(readFileSync(join(REPO, ".codex/hooks.json"), "utf8")) as {
  hooks: Record<string, Group[]>;
};
function wired(event: string, tool?: string): string[] {
  return (config.hooks[event] ?? [])
    .filter((group) => !group.matcher || (tool && new RegExp(group.matcher).test(tool)))
    .flatMap((group) => group.hooks.map((hook) => hook.command))
    .filter((command) => command.includes("inject-rules.ts"));
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The hook's per-session sent lists, kept apart from the machine's temp directory.
let state = "";
beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), "inject-rules-state-"));
});
afterAll(() => {
  rmSync(state, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "inject-rules-"));
  dirs.push(dir);
  return dir;
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A git repo carrying the hook and the given rule files (repo-relative path to content). */
function fixture(rules: Record<string, string>): string {
  const repo = temp();
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".codex/hooks"), { recursive: true });
  copyFileSync(
    join(REPO, ".codex/hooks/inject-rules.ts"),
    join(repo, ".codex/hooks/inject-rules.ts"),
  );
  for (const [path, text] of Object.entries(rules)) put(repo, path, text);
  return repo;
}

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

type Run = { sessionId?: string; event?: string; env?: NodeJS.ProcessEnv; stdin?: string };

function run(cwd: string, command: string, options: Run = {}) {
  const event = options.event ?? "PreToolUse";
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: state, ...options.env };
  for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[key];
  const [hook = "exit 1"] = wired(event, event === "PreToolUse" ? "apply_patch" : undefined);
  return spawnSync("sh", ["-c", hook], {
    cwd,
    env,
    encoding: "utf8",
    input:
      options.stdin ??
      JSON.stringify({
        session_id: options.sessionId ?? randomUUID(),
        cwd,
        hook_event_name: event,
        tool_name: "apply_patch",
        tool_input: { command },
      }),
  });
}

/** The context the hook adds for a patch, or undefined when it adds none. */
function contextFor(cwd: string, command: string, options: Run = {}): string | undefined {
  const result = run(cwd, command, options);
  expect(result.status, result.stderr).toBe(0);
  if (!result.stdout.trim()) return undefined;
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  return output.hookSpecificOutput.additionalContext;
}

const rules = {
  ".claude/rules/src.md": '---\npaths:\n  - "src/**/*.ts"\n---\n\nSRC RULE BODY\n',
  ".claude/rules/nested/tests.md": "---\npaths:\n  - tests/**\n---\nTESTS RULE BODY\n",
  ".claude/rules/always.md": "ALWAYS RULE BODY\n",
};
const editSrc = patch("*** Update File: src/a/b.ts", "@@", "+x");

// Every case spawns bun through a shell; under load that outlasts Vitest's 5 s default.
describe("Codex rules hook", { timeout: 30_000 }, () => {
  it("is wired once for apply_patch and once for PostCompact", () => {
    expect(wired("PreToolUse", "apply_patch")).toHaveLength(1);
    expect(wired("PreToolUse", "Bash")).toHaveLength(0);
    expect(wired("PostCompact")).toHaveLength(1);
  });

  it("adds the rules covering the patched files, without their frontmatter", () => {
    const context = contextFor(fixture(rules), editSrc);
    expect(context).toContain("SRC RULE BODY");
    expect(context).toContain("ALWAYS RULE BODY");
    expect(context).toContain(".claude/rules/src.md applies to src/a/b.ts");
    expect(context).toContain("check it against these rules");
    expect(context).not.toContain("TESTS RULE BODY");
    expect(context).not.toContain("paths:");
  });

  it("sends each rule once per session and again in a new session", () => {
    const repo = fixture(rules);
    const sessionId = randomUUID();
    const first = patch("*** Add File: src/x.ts", "+x");
    expect(contextFor(repo, first, { sessionId })).toContain("SRC RULE BODY");
    expect(contextFor(repo, first, { sessionId })).toBeUndefined();
    const later = contextFor(repo, patch("*** Update File: tests/x.test.ts", "@@", "+x"), {
      sessionId,
    });
    expect(later).toContain("TESTS RULE BODY");
    expect(later).not.toContain("SRC RULE BODY");
    expect(contextFor(repo, first)).toContain("SRC RULE BODY");
  });

  it("sends the rules again after a compaction", () => {
    const repo = fixture(rules);
    const sessionId = randomUUID();
    expect(contextFor(repo, editSrc, { sessionId })).toContain("SRC RULE BODY");
    const reset = run(repo, "", { sessionId, event: "PostCompact" });
    expect(reset.status, reset.stderr).toBe(0);
    expect(reset.stdout).toBe("");
    expect(contextFor(repo, editSrc, { sessionId })).toContain("SRC RULE BODY");
  });

  it("resolves absolute, moved and dot-prefixed paths and ignores deleted files", () => {
    const repo = fixture({
      ...rules,
      ".claude/rules/dots.md": '---\npaths:\n  - "..notes/**"\n---\nDOTS RULE BODY\n',
    });
    expect(
      contextFor(
        repo,
        patch("*** Update File: notes.md", "*** Move to: tests/notes.md", "@@", "+x"),
      ),
    ).toContain("TESTS RULE BODY");
    expect(
      contextFor(repo, patch(`*** Update File: ${join(repo, "src/y.ts")}`, "@@", "+x")),
    ).toContain("SRC RULE BODY");
    expect(contextFor(repo, patch("*** Add File: ..notes/a.md", "+x"))).toContain("DOTS RULE BODY");
    expect(contextFor(repo, patch("*** Delete File: src/z.ts"))).toBeUndefined();
    expect(contextFor(repo, patch("*** Add File: ../elsewhere/a.ts", "+x"))).toBeUndefined();
  });

  it("matches from a subdirectory and through a symlinked checkout", () => {
    const repo = fixture(rules);
    mkdirSync(join(repo, "src"), { recursive: true });
    expect(contextFor(join(repo, "src"), patch("*** Add File: c.ts", "+x"))).toContain(
      ".claude/rules/src.md applies to src/c.ts",
    );
    const link = join(temp(), "checkout");
    symlinkSync(repo, link);
    expect(contextFor(link, patch(`*** Add File: ${join(link, "src/d.ts")}`, "+x"))).toContain(
      ".claude/rules/src.md applies to src/d.ts",
    );
  });

  it("scopes CRLF, inline-array, scalar and commented paths, and skips empty ones", () => {
    const repo = fixture({
      ".claude/rules/crlf.md": '---\r\npaths:\r\n  - "docs/**"\r\n---\r\nCRLF RULE BODY\r\n',
      ".claude/rules/inline.md": "---\npaths: [\"docs/**\", 'lib/**']\n---\nINLINE RULE BODY\n",
      ".claude/rules/scalar.md": "---\npaths: docs/**\n---\nSCALAR RULE BODY\n",
      ".claude/rules/comment.md":
        '---\npaths:\n  - "docs/**" # docs only\n---\nCOMMENT RULE BODY\n',
      ".claude/rules/empty.md": "---\npaths:\ndescription: none\n---\nEMPTY RULE BODY\n",
    });
    expect(contextFor(repo, patch("*** Add File: src/a.ts", "+x"))).toBeUndefined();
    const docs = contextFor(repo, patch("*** Add File: docs/a.md", "+x"));
    for (const body of ["CRLF", "INLINE", "SCALAR", "COMMENT"]) {
      expect(docs).toContain(`${body} RULE BODY`);
    }
    expect(docs).not.toContain("EMPTY RULE BODY");
    expect(docs).not.toContain("---\r");
    expect(contextFor(repo, patch("*** Add File: lib/a.ts", "+x"))).toContain("INLINE RULE BODY");
  });

  it("does not treat a later frontmatter list as paths", () => {
    const repo = fixture({
      ".claude/rules/scoped.md":
        "---\npaths:\n  - src/**\ntags:\n  - docs/**\n---\nSCOPED RULE BODY\n",
    });
    expect(contextFor(repo, patch("*** Add File: docs/a.md", "+x"))).toBeUndefined();
    expect(contextFor(repo, editSrc)).toContain("SCOPED RULE BODY");
  });

  it("names every covered file and no uncovered file in the rule header", () => {
    const repo = fixture({ ".claude/rules/src.md": rules[".claude/rules/src.md"] });
    const context = contextFor(
      repo,
      patch(
        "*** Add File: src/a.ts",
        "+a",
        "*** Add File: docs/a.md",
        "+b",
        "*** Add File: src/nested/b.ts",
        "+c",
      ),
    );
    expect(context).toContain(
      "Project rule .claude/rules/src.md applies to src/a.ts, src/nested/b.ts.\n",
    );
    expect(context).not.toContain("docs/a.md");
  });

  it("never sends a rule with frontmatter and an empty body", () => {
    const repo = fixture({
      ".claude/rules/empty.md": "---\npaths:\n  - src/**\n---\n  \n",
    });
    expect(contextFor(repo, editSrc)).toBeUndefined();
  });

  it("names a patched file only once when it appears repeatedly", () => {
    const repo = fixture({ ".claude/rules/src.md": rules[".claude/rules/src.md"] });
    const context = contextFor(
      repo,
      patch("*** Add File: src/a.ts", "+a", "*** Update File: src/a.ts", "@@", "+b"),
    );
    expect(context).toContain("Project rule .claude/rules/src.md applies to src/a.ts.\n");
  });

  it("rewrites rule links to repo-relative paths", () => {
    const repo = fixture({
      ".claude/rules/nested/doc.md":
        "Read [Doc](../../../docs/guide.md#part), [Site](https://example.com) and [Top](#top).\n",
    });
    const context = contextFor(repo, editSrc);
    expect(context).toContain("[Doc](docs/guide.md#part)");
    expect(context).toContain("[Site](https://example.com)");
    expect(context).toContain("[Top](#top)");
  });

  it("follows symlinked rules and skips unreadable ones", () => {
    const repo = fixture({ ...rules, "shared/linked.md": "LINKED RULE BODY\n" });
    symlinkSync(join(repo, "shared/linked.md"), join(repo, ".claude/rules/linked.md"));
    symlinkSync(join(repo, "missing.md"), join(repo, ".claude/rules/dangling.md"));
    put(repo, ".claude/rules/locked.md", "LOCKED RULE BODY\n");
    chmodSync(join(repo, ".claude/rules/locked.md"), 0o000);
    const context = contextFor(repo, editSrc);
    expect(context).toContain("LINKED RULE BODY");
    expect(context).toContain("SRC RULE BODY");
    expect(context).not.toContain("LOCKED RULE BODY");
  });

  it("stays under the context budget and carries the rest on a later patch", () => {
    const repo = fixture({
      ".claude/rules/a.md": `A RULE BODY ${"a".repeat(5000)}\n`,
      ".claude/rules/b.md": `B RULE BODY ${"b".repeat(5000)}\n`,
      ".claude/rules/huge.md": `HUGE RULE BODY ${"h".repeat(20_000)}\n`,
    });
    const sessionId = randomUUID();
    const first = contextFor(repo, editSrc, { sessionId }) ?? "";
    expect(first).toContain("A RULE BODY");
    expect(first).not.toContain("B RULE BODY");
    expect(first).toContain(".claude/rules/huge.md applies to src/a/b.ts. It is too long");
    expect(first.length).toBeLessThan(8400);
    expect(contextFor(repo, editSrc, { sessionId })).toContain("B RULE BODY");
  });

  it("adds nothing for a malformed payload, a repo without rules, or a machine without bun", () => {
    const repo = fixture(rules);
    const malformed = run(repo, "", { stdin: "not json" });
    expect(malformed.status, malformed.stderr).toBe(0);
    expect(malformed.stdout).toBe("");
    expect(contextFor(fixture({}), editSrc)).toBeUndefined();
    const noBun = run(repo, editSrc, { env: { PATH: "/usr/bin:/bin" } });
    expect(noBun.status, noBun.stderr).toBe(0);
    expect(noBun.stdout).toBe("");
  });

  it("hands Codex this repo's CLI rules for a command file", () => {
    const context = contextFor(REPO, patch("*** Update File: src/commands/doctor.ts", "@@", "+x"));
    for (const rule of ["src/cli.md", "src/typescript.md", "src/verification.md", "effect.md"]) {
      expect(context).toContain(`.claude/rules/${rule}`);
    }
    expect(context).toContain("](docs/guidance/typescript-cli/cli.md)");
    expect(context).not.toContain(".claude/rules/src/testing.md");
  });
});
