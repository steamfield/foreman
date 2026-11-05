// Runs the Claude Code hooks in .claude/hooks the way Claude Code does: the command wired in
// .claude/settings.json for an event (and tool matcher), through `sh -c`, with the JSON payload
// on stdin. Tests assert on what comes back (stdout, exit code), so they hold whatever language
// a hook is written in.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = realpathSync(join(import.meta.dirname, "..", ".."));

// The literal text settings.json uses, expanded by the shell Claude Code runs hooks in.
const PROJECT_DIR_VAR = "$" + "{CLAUDE_PROJECT_DIR}";

type HookGroup = { matcher?: string; hooks: { command: string }[] };
const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8")) as {
  hooks: Record<string, HookGroup[]>;
};

/** Every hook command wired in settings.json, with ${CLAUDE_PROJECT_DIR} left in. */
export function wiredCommands(): string[] {
  return Object.values(settings.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
}

/** The command wired for `script` under `event` whose matcher accepts `tool`. Throws unless exactly one. */
export function hookCommand(event: string, script: string, tool?: string): string {
  const commands = (settings.hooks[event] ?? [])
    .filter((group) => !group.matcher || (tool && new RegExp(`^(${group.matcher})$`).test(tool)))
    .flatMap((group) => group.hooks.map((hook) => hook.command))
    .filter((command) => new RegExp(`/${script}\\.[a-z]+"?$`).test(command));
  if (commands.length !== 1) {
    throw new Error(`${script} is wired ${commands.length} time(s) for ${event} ${tool ?? ""}`);
  }
  return (commands[0] as string).replaceAll(PROJECT_DIR_VAR, REPO);
}

export type HookOutput = {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};

export type HookResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, when it is JSON. */
  output?: HookOutput | undefined;
};

export type RunOptions = {
  /** Merged over the test process env. CLAUDE_PROJECT_DIR defaults to the repo. */
  env?: Record<string, string | undefined> | undefined;
  cwd?: string;
  /** The tool name for matching, when the payload doesn't carry one (a raw string). */
  tool?: string;
};

// Git sets these inside git hooks (lefthook runs the tests from pre-push); inherited, they would
// point a fixture's git commands at this repo.
const INHERITED_GIT_VARS = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
];

/** Run a hook with a payload (an object is sent as JSON, a string as is). */
export function runHook(
  event: string,
  script: string,
  payload: unknown,
  options: RunOptions = {},
): Promise<HookResult> {
  const tool =
    typeof payload === "object" && payload !== null && "tool_name" in payload
      ? String(payload.tool_name)
      : options.tool;
  const command = hookCommand(event, script, tool);
  const merged: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: REPO,
    ...options.env,
  };
  for (const key of INHERITED_GIT_VARS) delete merged[key];
  const env = Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd: options.cwd ?? REPO, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let output: HookOutput | undefined;
      try {
        output = stdout.trim() ? (JSON.parse(stdout) as HookOutput) : undefined;
      } catch {
        // Plain-text output (SessionStart hooks); leave `output` unset.
      }
      resolve({ code, stdout, stderr, output });
    });
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

/** The deny reason, or undefined when the hook allowed the call (printed nothing). */
export function denyReason(result: HookResult): string | undefined {
  const out = result.output?.hookSpecificOutput;
  return out?.permissionDecision === "deny" ? out.permissionDecisionReason : undefined;
}

export const bash = (command: unknown) => ({
  session_id: "test-session",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

export const write = (
  file_path: string | undefined,
  content: string,
  session = "test-session",
) => ({
  session_id: session,
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path, content },
});

export const edit = (file_path: string, new_string: string, session = "test-session") => ({
  session_id: session,
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  tool_input: { file_path, old_string: "x", new_string },
});

export type Fixture = {
  /** The path mkdtemp returned (on macOS under /var, a symlink to /private/var). */
  dir: string;
  /** The same directory with symlinks resolved. */
  real: string;
  cleanup: () => void;
};

/**
 * A temp project directory. Its node_modules is a real directory holding only a `.bin` link to
 * the repo's, so the repo's biome and tsc run there while caches (tsc build info) stay local.
 */
export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(join(REPO, "node_modules", ".bin"), join(dir, "node_modules", ".bin"));
  return {
    dir,
    real: realpathSync(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
