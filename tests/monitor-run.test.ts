import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Stream } from "effect";
import { createElement } from "react";
import { expect, it } from "vitest";
import { Terminal } from "../src/services/terminal";
import { runMonitor } from "../src/tui/run";
import { MonitorApp } from "../src/tui/screen";
import { ndjson, runCli, tempDir } from "./helpers/cli";
import { defaults, live, now } from "./helpers/monitor";
import { monitorTerminal } from "./helpers/monitor-terminal";

const renderError = new Error("private render fixture text");
const ThrowingApp: typeof MonitorApp = (props) => {
  if (props.model.screen === "list") throw renderError;
  return createElement(MonitorApp, props);
};
it("restores the terminal and reports one defect when a component throws during render", async () => {
  const terminal = monitorTerminal();
  const home = await tempDir();
  const log = join(home, "cli.jsonl");
  const defects: unknown[] = [];
  const result = await runCli(["monitor"], {
    home,
    env: { TEST_CLI_LOG_FILE: log },
    program: Effect.gen(function* () {
      yield* runMonitor(
        yield* Terminal,
        { group: "/repo", defaults, version: "test", now, columns: 100, rows: 40 },
        Stream.make(live()),
        () => Stream.never,
        true,
        undefined,
        ThrowingApp,
      ).pipe(
        Effect.scoped,
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            defects.push(...cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect));
          }),
        ),
      );
    }).pipe(Effect.provide(terminal.layer)),
  });
  expect({
    ...result,
    stderr: result.stderr.replace(
      /^\S+ error (monitor\.render\.failed|defect) \{[^\n]*\}$/gm,
      "$1",
    ),
  }).toEqual({ status: 1, stdout: "", stderr: "monitor.render.failed\ndefect\nInternal error.\n" });
  expect(defects).toEqual([renderError]);
  const records = ndjson(await readFile(log, "utf8"));
  expect(
    records.filter(
      (record) =>
        typeof record === "object" && record !== null && "msg" in record && record.msg === "defect",
    ),
  ).toHaveLength(1);
  expect(records).toContainEqual(expect.objectContaining({ msg: "monitor.render.failed" }));
  expect(JSON.stringify(records)).not.toContain(renderError.message);
  expect(terminal.output()).toContain("\u001b[?1049h");
  expect(terminal.output().split("\u001b[?1049l")).toHaveLength(2);
  expect(terminal.stdin.isRaw).toBe(false);
});
