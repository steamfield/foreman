#!/usr/bin/env node
// Record forman CLI output as a scrubbed fixture.
//
//   node scripts/capture-cli.mjs <fixture-name> -- forman status
//   node scripts/capture-cli.mjs <fixture-name> --from <file> --command "forman start ..."
//
// Writes fixtures/cli/<fixture-name>.json: { command, output, exitCode }.
// The first form runs the command from the repository root; the second records a
// transcript saved earlier (a background `start --wait` piped through tee).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(
  /\/$/,
  "",
);
const outDir = new URL("../fixtures/cli/", import.meta.url);

function scrubPaths(text) {
  return text
    .replaceAll(repo, "~/src/forman")
    .replace(/\/private\/tmp\/claude-[^\s'"`)]*/g, "/tmp/scratch")
    .replace(/\/var\/folders\/[^\s'"`)]*/g, "/tmp/scratch")
    .replaceAll(homedir(), "~")
    .replace(new RegExp(`\\b${userInfo().username}\\b`, "g"), "dev");
}

// Wait cursors are base64url JSON that name the repository path: decode, scrub, re-encode.
function scrubCursors(text) {
  return text.replace(/\beyJ[A-Za-z0-9_-]+/g, (cursor) => {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    return Buffer.from(scrubPaths(json), "utf8").toString("base64url");
  });
}

function scrub(text) {
  return scrubPaths(scrubCursors(text));
}

const [name, ...rest] = process.argv.slice(2);
if (!name || rest.length === 0) {
  console.error(
    "usage: capture-cli.mjs <name> -- <command...> | --from <file> --command <cmd>",
  );
  process.exit(2);
}

let record;
if (rest[0] === "--") {
  const [cmd, ...args] = rest.slice(1);
  const result = spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
  record = {
    command: scrub([cmd, ...args].join(" ")),
    output: scrub(`${result.stdout}${result.stderr}`),
    exitCode: result.status,
  };
} else {
  const from = rest[rest.indexOf("--from") + 1];
  const command = rest[rest.indexOf("--command") + 1];
  record = {
    command: scrub(command),
    output: scrub(readFileSync(from, "utf8")),
    exitCode: 0,
  };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  new URL(`${name}.json`, outDir),
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(`fixtures/cli/${name}.json`);
