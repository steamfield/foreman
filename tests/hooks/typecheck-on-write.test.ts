import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, makeFixture, runHook } from "../helpers/hooks";

let project: Fixture;

beforeEach(() => {
  project = makeFixture();
  writeFileSync(
    join(project.dir, "tsconfig.json"),
    JSON.stringify({
      include: ["**/*.ts"],
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        lib: ["ES2022"],
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        skipLibCheck: true,
      },
    }),
  );
});
afterEach(() => project.cleanup());

const put = (name: string, content: string) => {
  const path = join(project.dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const typecheck = async (filePath: string) => {
  const result = await runHook(
    "PostToolUse",
    "typecheck-on-write",
    { session_id: "tc", tool_name: "Edit", tool_input: { file_path: filePath } },
    { env: { CLAUDE_PROJECT_DIR: project.dir } },
  );
  return { result, context: result.output?.hookSpecificOutput?.additionalContext };
};

describe("typecheck-on-write", { timeout: 60_000 }, () => {
  it("reports errors in the written file first", async () => {
    put("src/other.ts", "export const s: string = 1;\n");
    const { context } = await typecheck(put("src/a.ts", "export const n: number = 'x';\n"));
    expect(context).toMatch(
      /^tsc found 2 type error\(s\), 1 in src\/a\.ts\. Fix the ones in this file now;[^\n]*\nsrc\/a\.ts\(1,14\): error TS2322/,
    );
    expect(context).toContain("src/other.ts(1,14): error TS2322");
  });

  it("says when every error is in another file", async () => {
    put("b.ts", 'import { n } from "./a";\nexport const s: string = n;\n');
    const { context } = await typecheck(put("a.ts", "export const n = 1;\n"));
    expect(context).toMatch(/^tsc found 1 type error\(s\) in other files \(none in a\.ts\)\./);
    expect(context).toContain("b.ts(2,14): error TS2322");
  });

  it("says nothing when the project type-checks", async () => {
    const { result } = await typecheck(put("a.ts", "export const n = 1;\n"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("ignores build output", async () => {
    put("a.ts", "export const n: number = 'x';\n");
    const { result } = await typecheck(put("dist/gen.ts", "export const x = 1;\n"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("ignores files that aren't TypeScript", async () => {
    put("a.ts", "export const n: number = 'x';\n");
    const { result } = await typecheck(put("tool.js", "export const x = 1;\n"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("truncates a long error list", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `export const n${i}: number = 'x';`);
    const { context } = await typecheck(put("a.ts", `${lines.join("\n")}\n`));
    const body = (context ?? "").split("\n");
    expect(body).toHaveLength(42);
    expect(body.at(-1)).toBe("... (truncated; run bun run typecheck for the rest)");
  });
});
