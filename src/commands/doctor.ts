import { Effect } from "effect";
import { Command } from "effect/cli";
import { doctor } from "../core/doctor";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

export const doctorCommand = Command.make(
  "doctor",
  {},
  Effect.fn(function* () {
    yield* Effect.flatMap(Invocation, (invocation) => invocation.named("doctor"));
    const output = yield* Output;
    const result = yield* doctor();
    yield* output.result(
      result,
      [
        `${result.name} ${result.version} (${result.platform}, compiled: ${result.compiled})`,
        `forman on PATH is this binary: ${result.formanOnPath}`,
        `Codex executable: ${result.codexBin}`,
        `Config: ${result.configError ?? "ok"}`,
        `Config file: ${result.configFile}`,
        `Home: ${result.home}`,
        `Codex: ${result.codexVersion ?? "unavailable"}`,
        `Protocol matches: ${result.protocolMatches ?? "unavailable"}`,
        `Logged in: ${result.loggedIn ?? "unavailable"}`,
        ...(result.repoHooks.state === "not applicable"
          ? ["Repo hooks: no repo hooks apply."]
          : [
              result.repoHooks.state === "unknown"
                ? `Repo hooks: unknown (${result.repoHooks.detail ?? "hook trust could not be checked"})`
                : "Repo hooks:",
              ...result.repoHooks.hooks.map(
                (hook) => `  ${hook.key.split(":").slice(-3).join(":")}  ${hook.status}`,
              ),
              result.repoHooks.acceptsStart === null
                ? "  forman start: unknown (hook trust could not be checked)."
                : `  forman start will ${result.repoHooks.acceptsStart ? "accept" : "refuse"} runs here (hook trust).`,
            ]),
        result.daemon.state === "running"
          ? `Daemon: running ${result.daemon.version} (pid ${result.daemon.pid})`
          : "Daemon: not running",
        ...(result.daemon.state === "running"
          ? [
              `Daemon build: ${result.daemon.build ?? "unknown"}`,
              `Daemon build matches this CLI: ${result.daemon.buildMatches ?? "unknown"}`,
            ]
          : []),
      ].join("\n"),
    );
  }),
).pipe(
  Command.withDescription("Inspect runtime and configuration without requiring valid settings."),
);
