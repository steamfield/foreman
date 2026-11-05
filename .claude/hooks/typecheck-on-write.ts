// PostToolUse (Edit|Write) on a .ts/.tsx file: type-check the project and hand any errors back
// to the agent as additionalContext, so a type error shows up right after the edit that caused it
// instead of at `bun run typecheck` time.
//
// Advisory: never blocks. tsc runs incrementally (build info under node_modules/.cache/), about
// 1.5s after the first run. Errors in the written file come first; errors elsewhere are included
// because an edit can break the files that use it. tsc not installed, timed out, or crashed: no
// output. tsc gets 40s, under the hook's 60s timeout in settings.json.
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  addContext,
  isExecutable,
  isFile,
  projectRoot,
  readPayload,
  run,
  stripControl,
  text,
} from "./_lib";

// An error is a `path(line,col): error TS...` line plus indented continuation lines.
const ERROR_LINE = /^[^ ].*\([0-9]+,[0-9]+\): error /;
const MAX_LINES = 40;

/** The error blocks (error line plus continuations) for which `keep(errorLine)` holds. */
function errorBlocks(lines: string[], keep: (line: string) => boolean): string[] {
  let keeping = false;
  return lines.filter((line) => {
    if (ERROR_LINE.test(line)) keeping = keep(line);
    return keeping;
  });
}

async function main(): Promise<void> {
  const given = text(readPayload()?.tool_input?.file_path);
  if (!(given.endsWith(".ts") || given.endsWith(".tsx")) || !isFile(given)) return;

  let root: string;
  let fileDir: string;
  try {
    root = realpathSync(projectRoot());
    fileDir = realpathSync(dirname(given));
  } catch {
    return;
  }
  if (!`${fileDir}/`.startsWith(`${root}/`)) return;
  // tsc prints paths relative to the root; match that.
  const rel =
    fileDir === root ? basename(given) : `${fileDir.slice(root.length + 1)}/${basename(given)}`;
  if (
    ["node_modules/", "dist/", "coverage/", "build/", ".react-router/"].some((dir) =>
      rel.startsWith(dir),
    )
  )
    return;

  const tsc = join(root, "node_modules/.bin/tsc");
  if (!isExecutable(tsc)) return;

  const prepare = join(root, ".claude/hooks/before-typecheck.ts");
  if (isFile(prepare)) {
    await run("bun", [prepare, rel], { cwd: root, timeoutSec: 15 });
  }

  const { code, output } = await run(
    tsc,
    [
      "--noEmit",
      "--pretty",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      "node_modules/.cache/tsc/hook.tsbuildinfo",
    ],
    { cwd: root, timeoutSec: 40 },
  );
  // 0: clean. 1/2: type errors. Anything else (timeout 124, a crash): say nothing.
  if (code !== 1 && code !== 2) return;
  const lines = stripControl(output).replace(/\n+$/, "").split("\n");

  const mineFirst = (line: string) => line.startsWith(`${rel}(`);
  const mine = errorBlocks(lines, mineFirst);
  const others = errorBlocks(lines, (line) => !mineFirst(line));
  const total = lines.filter((line) => ERROR_LINE.test(line)).length;
  const here = mine.filter((line) => ERROR_LINE.test(line)).length;
  if (total === 0) return;

  let body = [...mine, ...others].filter((line) => line !== "");
  if (body.length > MAX_LINES) {
    body = [...body.slice(0, MAX_LINES), "... (truncated; run bun run typecheck for the rest)"];
  }
  const message =
    here > 0
      ? `tsc found ${total} type error(s), ${here} in ${rel}. Fix the ones in this file now; errors in other files may be from an edit still in progress:`
      : `tsc found ${total} type error(s) in other files (none in ${rel}). Either an edit is still in progress, or this edit broke code that uses it:`;
  addContext(`${message}\n${body.join("\n")}`);
}

await main();
