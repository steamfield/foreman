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
        `Greeting: ${result.greeting ?? "unavailable"}`,
        `Config: ${result.configError ?? "ok"}`,
        `Config file: ${result.configFile}`,
        `Data: ${result.dataDir}`,
        `Codex: ${result.codexVersion ?? "unavailable"}`,
        `Protocol matches: ${result.protocolMatches ?? "unavailable"}`,
        `Logged in: ${result.loggedIn ?? "unavailable"}`,
        result.daemon.state === "running"
          ? `Daemon: running ${result.daemon.version} (pid ${result.daemon.pid})`
          : "Daemon: not running",
      ].join("\n"),
    );
  }),
).pipe(
  Command.withDescription("Inspect runtime and configuration without requiring valid settings."),
);
