// Protect the Node unit runner and explicitly scoped Bun binary/native tests.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deny, projectRoot, readPayload, text } from "./_lib";
import { commands } from "./_shell";

const VALUE_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--preload",
  "--rerun-each",
  "--retry",
  "--seed",
  "--max-concurrency",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
]);
const UNIT_SCRIPTS = new Set(["test", "test:unit", "test:watch", "coverage"]);
const testRoots = ["e2e"];
// Optional native capabilities declare their own roots; the base names no app paths.
const configPath = join(projectRoot(), ".claude/platform-paths.json");
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (Array.isArray(config.bunTestPaths)) {
    testRoots.push(
      ...config.bunTestPaths.filter(
        (path: unknown): path is string =>
          typeof path === "string" &&
          /^[\w.-]+(?:\/[\w.-]+)*$/.test(path) &&
          !path.split("/").some((part) => part === "." || part === ".."),
      ),
    );
  }
}

const command = text(readPayload()?.tool_input?.command);
for (const { argv } of commands(command ?? "")) {
  const [first = "", ...args] = argv;
  const name = basename(first);
  const vitest = args.some((arg) => basename(arg) === "vitest");
  const unitScript = args.includes("run") && args.some((arg) => UNIT_SCRIPTS.has(arg));
  if (["bun", "bunx"].includes(name) && args.includes("--bun") && (vitest || unitScript)) {
    deny("BLOCKED: Vitest runs on Node. Drop --bun and use the project test commands.");
    break;
  }
  if (name === "bun" && args[0] === "test") {
    const rest = args.slice(1);
    const positional = rest.filter(
      (arg, index) => !arg.startsWith("-") && !VALUE_FLAGS.has(rest[index - 1] ?? ""),
    );
    const paths = positional.filter((arg) => arg.includes("/") || /\.[cm]?[jt]sx?$/.test(arg));
    const scoped =
      paths.length > 0 &&
      paths.every(
        (path) =>
          !path.split("/").includes("..") &&
          testRoots.some((root) => path === `./${root}` || path.startsWith(`./${root}/`)),
      );
    if (!scoped) {
      deny(
        "BLOCKED: Scope Bun's runner to its declared binary/native tests; use bun run test for the Node unit suite.",
      );
      break;
    }
  }
  if (
    name === "bun" &&
    ["add", "install", "i", "a"].includes(args[0] ?? "") &&
    args.some((arg) => /^(?:zod|@effect\/(?:schema|platform))(@|$)/.test(arg))
  ) {
    deny(
      "BLOCKED: Use Schema and platform modules from the installed effect package, not competing schema or legacy platform packages.",
    );
    break;
  }
}
