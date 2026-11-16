import { Clock, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { AppConfig } from "../config";
import { realPath } from "../core/command-input";
import * as programs from "../core/commands";
import { mainCheckout } from "../core/main-checkout";
import { detailFeed } from "../core/monitor/detail-feed";
import { monitorFeed } from "../core/monitor/feed";
import { defaultModel } from "../core/preflight/model";
import { RunName } from "../schemas/daemon";
import { Host } from "../services/host";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";
import { Terminal } from "../services/terminal";
import { print } from "./runs";

export const makeMonitorCommand = (
  source: typeof monitorFeed = monitorFeed,
  detail: typeof detailFeed = detailFeed,
) =>
  Command.make(
    "monitor",
    {
      name: Argument.String("name").pipe(
        Argument.withSchema(RunName),
        Argument.optional,
        Argument.map(Option.getOrUndefined),
      ),
    },
    Effect.fn(function* ({ name }) {
      yield* (yield* Invocation).named("monitor");
      const config = yield* AppConfig;
      const terminal = yield* Terminal;
      const output = yield* Output;
      if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY || config.inDelegate || output.json) {
        yield* print("monitor", programs.status(name, name === undefined));
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
          ...(name === undefined ? {} : { name }),
        },
        source(config.home),
        (name) => detail(config.home, name),
        config.inheritedEnvironment.NO_COLOR !== undefined,
      ).pipe(Effect.scoped);
    }),
  ).pipe(
    Command.withDescription(
      "Watch runs across repositories or open one run's detail in an interactive terminal. Enter opens detail or expands older idle runs; Tab changes pane, j/k scroll, f toggles follow and Esc returns to the list. Read-only; never starts a daemon in the live view. With --json, redirected streams or CODEX_DELEGATE, prints status <name> for a named run or status --all otherwise. Exits 0 on q or a snapshot, 2 for usage, 3 for config, 4 for daemon failure, 6 for permissions, 7 for a missing snapshot run, 130 when interrupted, 1 on an internal error.",
    ),
    Command.withShortDescription("Watch a live list or run detail; otherwise print a snapshot."),
    Command.withExamples([
      { command: "foreman monitor", description: "Open the live list across repositories" },
      { command: "foreman monitor fix-hooks", description: "Open a run's detail and live feed" },
      { command: "foreman monitor --json", description: "Read an Overview snapshot for scripts" },
    ]),
  );
export const monitorCommand = makeMonitorCommand();
