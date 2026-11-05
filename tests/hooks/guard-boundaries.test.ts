import { describe, expect, it } from "vitest";
import { denyReason, REPO, runHook, write } from "../helpers/hooks";

const check = (path: string, content: string) =>
  runHook("PreToolUse", "guard-boundaries", write(`${REPO}/${path}`, content));
describe("base platform boundaries", () => {
  it.each([
    ["src/core/doctor.ts", 'import { $ } from "bun";'],
    ["src/services/Host.ts", "const p = Bun.argv;"],
    ["src/main.ts", "process.stdout.write('x');"],
    ["src/core/doctor.ts", "process.env.SECRET;"],
    ["src/main.ts", "console.log('x');"],
    ["src/services/Output.ts", "process.stderr.write('x');"],
  ])("denies %s: %s", async (path, content) =>
    expect(denyReason(await check(path, content))).toBeDefined(),
  );
  it.each([
    ["src/bin.ts", 'import { BunRuntime } from "@effect/platform-bun";'],
    ["src/platform/host.ts", "const p = Bun.argv;"],
    ["src/config.ts", "const e = process.env;"],
    ["src/logging.ts", "process.stderr.write('x');"],
    ["src/core/doctor.ts", "// console.log('example')"],
  ])("allows %s: %s", async (path, content) =>
    expect(denyReason(await check(path, content))).toBeUndefined(),
  );
});
