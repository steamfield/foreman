// Runs the agy hook wiring in .agents/hooks.json the way agy does: the command for a tool's
// matcher, through `sh -c`, from the directory holding hooks.json, with agy's JSON on stdin.
// Tests assert on the decision agy would read from stdout.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO } from "../helpers/hooks";

const SPAWNS = { timeout: 30_000 };

type AgyHooksFile = Record<
  string,
  { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
>;
type AgyDecision = { decision: string; reason?: string };

const hooksFile = JSON.parse(
  readFileSync(join(REPO, ".agents/hooks.json"), "utf8"),
) as AgyHooksFile;

/** The command agy runs before `tool`, which must be wired exactly once. */
function wiredCommand(tool: string): string {
  const commands = Object.values(hooksFile).flatMap((hook) =>
    hook.PreToolUse.filter((group) => new RegExp(`^(${group.matcher})$`).test(tool)).flatMap(
      (group) => group.hooks.map((handler) => handler.command),
    ),
  );
  if (commands.length !== 1) throw new Error(`${tool} is wired ${commands.length} time(s)`);
  return commands[0] as string;
}

const agyCall = (name: string, args: Record<string, unknown>) => ({
  toolCall: { id: "toolu_01", name, args },
  stepIdx: 1,
  hookEventName: "PreToolUse",
  cwd: REPO,
});

/** Run the wired command for `tool` from `root`'s .agents directory and parse its decision. */
async function decide(root: string, tool: string, stdin: unknown): Promise<AgyDecision> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("sh", ["-c", wiredCommand(tool)], { cwd: join(root, ".agents") });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", reject);
    // A hook may decide and exit before reading its input (the missing-script case does).
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", () => resolve(out));
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
  return JSON.parse(stdout) as AgyDecision;
}

const decideInRepo = (tool: string, stdin: unknown) => decide(REPO, tool, stdin);

const copies: string[] = [];
/** A copy of the agy hooks and the Claude guards that a test may break. */
function copyOfHooks(): string {
  const root = mkdtempSync(join(tmpdir(), "agy-adapter-"));
  copies.push(root);
  cpSync(join(REPO, ".agents/hooks.json"), join(root, ".agents/hooks.json"));
  cpSync(join(REPO, ".agents/hooks"), join(root, ".agents/hooks"), { recursive: true });
  cpSync(join(REPO, ".claude/hooks"), join(root, ".claude/hooks"), { recursive: true });
  return root;
}
afterAll(() => {
  for (const root of copies) rmSync(root, { recursive: true, force: true });
});

describe("agy PreToolUse adapter", SPAWNS, () => {
  it("denies a destructive command with the guard's reason", async () => {
    const result = await decideInRepo(
      "run_command",
      agyCall("run_command", { CommandLine: "git push --force origin main" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("BLOCKED");
    expect(result.reason).toContain("Never work around this block.");
  });

  it("asks, not allows, for a harmless command", async () => {
    expect(
      await decideInRepo(
        "run_command",
        agyCall("run_command", { CommandLine: "git status --short" }),
      ),
    ).toEqual({ decision: "ask" });
  });

  it("writes nothing to stderr when a guard has no objection", async () => {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn("sh", ["-c", wiredCommand("run_command")], {
        cwd: join(REPO, ".agents"),
      });
      let err = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", () => resolve(err));
      child.stdin.end(
        JSON.stringify(agyCall("run_command", { CommandLine: "git status --short" })),
      );
    });
    expect(stderr).toBe("");
  });

  it("denies a write that contains a credential-shaped string", async () => {
    // Built at runtime so this file holds no credential-shaped literal.
    const key = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const result = await decideInRepo(
      "write_file",
      agyCall("write_file", { Path: "/tmp/repo/config.ts", Content: `const id = "${key}";` }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("AWS access key ID");
  });

  it("denies an edit that writes a real .env file", async () => {
    const result = await decideInRepo(
      "edit_file",
      agyCall("edit_file", { Path: "/tmp/repo/.env", NewString: "A=1" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain(".env");
  });

  it("denies an edit whose Replacement is credential-shaped", async () => {
    const key = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const result = await decideInRepo(
      "edit_file",
      agyCall("edit_file", {
        Path: "/tmp/repo/config.ts",
        Target: "const id = 1;",
        Replacement: `const id = "${key}";`,
      }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("AWS access key ID");
  });

  it("asks for a harmless edit", async () => {
    expect(
      await decideInRepo(
        "edit_file",
        agyCall("edit_file", { Path: "/tmp/repo/a.ts", Target: "a", Replacement: "b" }),
      ),
    ).toEqual({ decision: "ask" });
  });

  it("denies an edit with no content argument", async () => {
    const result = await decideInRepo(
      "edit_file",
      agyCall("edit_file", { Path: "/tmp/repo/a.ts", Target: "a" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("lacks the argument");
  });

  it("asks for a write with no credential", async () => {
    expect(
      await decideInRepo(
        "write_file",
        agyCall("write_file", { Path: "/tmp/repo/hello.txt", Content: "hello" }),
      ),
    ).toEqual({ decision: "ask" });
  });

  it("denies when the guard script is missing", async () => {
    const root = copyOfHooks();
    rmSync(join(root, ".claude/hooks/block-destructive.sh"));
    const result = await decide(root, "run_command", agyCall("run_command", { CommandLine: "ls" }));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("block-destructive.sh not found");
  });

  it.each([["echo hi\ngit push --force origin main"], ["echo hi\nrm -rf ~"]])(
    "denies a destructive line after the first: %j",
    async (commandLine) => {
      const result = await decideInRepo(
        "run_command",
        agyCall("run_command", { CommandLine: commandLine }),
      );
      expect(result.decision).toBe("deny");
    },
  );

  it("denies when _lib.sh is missing, with the real message", async () => {
    const root = copyOfHooks();
    rmSync(join(root, ".claude/hooks/_lib.sh"));
    const result = await decide(root, "run_command", agyCall("run_command", { CommandLine: "ls" }));
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("_lib.sh not found"),
    });
  });

  describe("with a broken guard", () => {
    const replaceGuard = (body: string) => {
      const root = copyOfHooks();
      writeFileSync(
        join(root, ".claude/hooks/block-destructive.sh"),
        `#!/usr/bin/env bash\n${body}\n`,
      );
      return root;
    };
    const lsCall = agyCall("run_command", { CommandLine: "ls" });

    it("denies a guard that exits nonzero, with its exit code and stderr", async () => {
      const result = await decide(replaceGuard("echo boom >&2; exit 1"), "run_command", lsCall);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("block-destructive.sh failed (exit 1)");
      expect(result.reason).toContain("boom");
    });

    it("denies output it cannot read, quoting the output", async () => {
      const result = await decide(replaceGuard(`echo '{"foo":1}'`), "run_command", lsCall);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("does not understand");
      expect(result.reason).toContain('{"foo":1}');
    });

    it("denies a guard that outlives the timeout, before agy's own 10 s", async () => {
      const started = Date.now();
      const result = await decide(replaceGuard("sleep 30"), "run_command", lsCall);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("did not finish within 8s");
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  it("denies when the adapter script is missing", async () => {
    const root = copyOfHooks();
    rmSync(join(root, ".agents/hooks/guard-adapter.sh"));
    const result = await decide(
      root,
      "write_file",
      agyCall("write_file", { Path: "a", Content: "b" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("guard-adapter.sh not found");
  });

  it.each([
    ["not JSON", "this is not json"],
    ["an empty payload", ""],
    ["a payload with no tool name", { toolCall: { args: { CommandLine: "ls" } } }],
  ])("denies malformed input: %s", async (_label, stdin) => {
    const result = await decideInRepo("run_command", stdin);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("toolCall.name");
  });

  it("denies a command call that carries no CommandLine", async () => {
    const result = await decideInRepo("run_command", agyCall("run_command", {}));
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("CommandLine");
  });
});
