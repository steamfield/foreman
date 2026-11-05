import { describe, expect, it } from "vitest";
import { bash, denyReason, runHook } from "../helpers/hooks";

const check = (command: string) => runHook("PreToolUse", "guard-cli-commands", bash(command));
describe("base CLI runner guard", () => {
  it.each([
    "bun test",
    "bun test --coverage",
    "bun test ./tests/config.test.ts",
    "bun test -t ./e2e",
    "bun --bun run test:unit",
    "bun --bun node_modules/.bin/vitest run",
    "bun add @effect/schema",
    "bun a @effect/schema",
    "bun add zod",
  ])("denies %s", async (command) => expect(denyReason(await check(command))).toBeDefined());
  it.each([
    "bun run test",
    "bun test ./e2e",
    "bun test ./e2e -t 'unit tests'",
    "git commit -m 'bun test'",
    "bun add effect",
  ])("allows %s", async (command) => expect(denyReason(await check(command))).toBeUndefined());
});
