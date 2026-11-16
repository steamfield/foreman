import { Clock, Effect } from "effect";
import { Command } from "effect/cli";
import { AppConfig } from "../config";
import { realPath } from "../core/command-input";
import * as programs from "../core/commands";
import { mainCheckout } from "../core/main-checkout";
import { monitorFeed } from "../core/monitor/feed";
import { defaultModel } from "../core/preflight/model";
import { Host } from "../services/host";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";
import { Terminal } from "../services/terminal";
import { print } from "./runs";

export const makeMonitorCommand = (source: typeof monitorFeed = monitorFeed) =>
  Command.make(
    "monitor",
    {},
    Effect.fn(function* () {
      yield* (yield* Invocation).named("monitor");
      const config = yield* AppConfig;
      const terminal = yield* Terminal;
      const output = yield* Output;
      if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY || config.inDelegate || output.json) {
        yield* print("monitor", programs.status(undefined, true));
        if (!output.json)
          yield* output.note("The live view needs an interactive terminal; showing a snapshot.");
        return;
      }
      const { runMonitor } = yield* Effect.promise(() => import("../tui/run"));
      yield* runMonitor(
        terminal,
        {
          group: (yield* mainCheckout(yield* realPath("."))) ?? "",
          defaults: {
            model: yield* defaultModel(config.codexHome),
            effort: "high",
            tier: "priority",
          },
          version: (yield* Host).version,
          now: yield* Clock.currentTimeMillis,
          columns: terminal.columns,
          rows: terminal.rows,
        },
        source(config.home),
        config.inheritedEnvironment.NO_COLOR !== undefined,
      ).pipe(Effect.scoped);
    }),
  ).pipe(
    Command.withDescription(
      "Watch runs across repositories in an interactive terminal. Use status --all for scripts and agents. Falls back to its snapshot with --json, redirected streams or CODEX_DELEGATE. Read-only; never starts a daemon in the live view. Enter expands older idle runs; run detail is not available yet. Exits 0 on q or a snapshot, 2 for usage, 3 for config, 4 for daemon failure, 6 for permissions, 130 when interrupted, 1 on an internal error.",
    ),
    Command.withShortDescription("Watch all runs live in a terminal; otherwise print a snapshot."),
    Command.withExamples([
      { command: "foreman monitor", description: "Open the live list across repositories" },
      { command: "foreman monitor --json", description: "Read an Overview snapshot for scripts" },
    ]),
  );
export const monitorCommand = makeMonitorCommand();
