import { Effect } from "effect";
import { Command } from "effect/cli";
import { renderOrphan } from "../core/command-output";
import { doctor } from "../core/doctor";
import type { DoctorResult } from "../schemas/doctor";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

function daemonSummary(daemon: typeof DoctorResult.Type.daemon): string {
  switch (daemon.state) {
    case "running":
      return `Daemon: running ${daemon.version} (pid ${daemon.pid})`;
    case "unavailable":
      return `Daemon: unavailable (${daemon.detail})`;
    case "not running":
      return "Daemon: not running (normal before first use: the first run command, such as `foreman status`, starts it)";
  }
}

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
        `foreman on PATH is this binary: ${result.foremanOnPath}`,
        `Codex executable: ${result.codexBin}`,
        `Config: ${result.configError ?? "ok"}`,
        `Config file: ${result.configFile}`,
        `Home: ${result.home}`,
        `Home permissions: ${result.homePermissions.state === "missing" ? "not created yet" : result.homePermissions.state}${result.homePermissions.detail === null ? "" : ` (${result.homePermissions.detail})`}`,
        `Codex: ${result.codexVersion ?? "unavailable"}`,
        `Protocol matches: ${result.protocolMatches ?? "unavailable"}`,
        `Logged in: ${result.loggedIn ?? "unavailable"}`,
        ...("orphans" in result ? (result.orphans ?? []).map(renderOrphan) : []),
        ...("orphanError" in result ? [`Orphans: ${result.orphanError}`] : []),
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
                ? "  foreman start: unknown (hook trust could not be checked)."
                : `  foreman start will ${result.repoHooks.acceptsStart ? "accept" : "refuse"} runs here (hook trust).`,
              ...(result.repoHooks.state === "known" && result.repoHooks.detail !== null
                ? [result.repoHooks.detail]
                : []),
            ]),
        daemonSummary(result.daemon),
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
  Command.withDescription(
    "Inspect config, executable identity, Codex login/protocol, repo hook trust, home permissions, orphan worktrees and daemon build. Works in any directory and run state, without starting a turn or starting or replacing a daemon. Read every probe even on exit 0; unavailable probes and invalid configuration are reported in the result. Never approves hooks or changes trust/auth. Exits 0 with the probe report, 2 for usage, 6 when output is refused, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Inspect config, Codex, repo hook trust and daemon state."),
  Command.withExamples([
    { command: "foreman doctor", description: "Check setup and hook trust from the main checkout" },
    {
      command: "foreman doctor --json",
      description: "Inspect probes and daemon build as one JSON result",
    },
  ]),
);
