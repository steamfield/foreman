import { Duration, Effect } from "effect";
import { ChildProcess } from "effect/process";
import { AppConfig } from "../config";
import { UpdateFailed } from "../errors";
import type { InstallMethod, UpdateResult } from "../schemas/update";
import { Host } from "../services/host";
import { commandResult, diagnosticTail } from "./process";

const packageName = "@steamfield/foreman";
const checkTimeout = Duration.seconds(30);
const installTimeout = Duration.minutes(5);

/** Where this foreman came from, read from the path of the npm launcher or the binary itself. */
export function installMethod(path: string | undefined): typeof InstallMethod.Type {
  if (!path || !/\/node_modules\/@steamfield\/foreman(-[a-z0-9-]+)?\//.test(path)) return "source";
  if (path.includes("/.bun/install/global/")) return "bun";
  if (path.includes("/_npx/")) return "npx";
  if (/\/pnpm\/global\//.test(path)) return "pnpm";
  if (/\/lib\/node_modules\/@steamfield\/foreman(-[a-z0-9-]+)?\//.test(path)) return "npm";
  return "project";
}

/** True when `latest` is a newer x.y.z than `current`; a non-release build such as `dev` is always older. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const next = parse(latest);
  const installed = parse(current);
  if (!next) return false;
  if (!installed) return true;
  for (let index = 0; index < 3; index++)
    if (next[index] !== installed[index]) return (next[index] ?? 0) > (installed[index] ?? 0);
  return false;
}

const installCommands: Partial<Record<typeof InstallMethod.Type, readonly string[]>> = {
  npm: ["npm", "install", "--global"],
  bun: ["bun", "add", "--global"],
  pnpm: ["pnpm", "add", "--global"],
};

// Run a package-manager command; any failure becomes one UpdateFailed that says what ran, what it
// printed and what to try next.
const run = Effect.fnUntraced(function* (
  argv: readonly string[],
  timeout: Duration.Duration,
  failed: string,
  next: string,
) {
  const config = yield* AppConfig;
  const [command = "", ...args] = argv;
  const shown = argv.join(" ");
  const result = yield* commandResult(
    ChildProcess.make(command, args, { env: config.inheritedEnvironment, extendEnv: false }),
    { output: "tail" },
  ).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new UpdateFailed({
            detail: `${failed}: ${shown} did not finish within ${Duration.format(timeout)}. ${next}`,
          }),
        ),
    }),
    Effect.mapError((error) =>
      error instanceof UpdateFailed
        ? error
        : new UpdateFailed({ detail: `${failed}: ${error.detail ?? `${shown} could not run`}` }),
    ),
  );
  if (result.code !== 0) {
    const output = diagnosticTail(`${result.stderr}\n${result.stdout}`.trim());
    return yield* new UpdateFailed({
      detail: `${failed}: ${shown} exited ${result.code}.${output ? `\n${output}` : ""}\n${next}`,
    });
  }
  return result.stdout.trim();
});

export const update = Effect.fn("update")(function* (options: { check: boolean }) {
  const host = yield* Host;
  const config = yield* AppConfig;
  const method = installMethod(config.launcher ?? host.executable[0]);
  const latest = yield* run(
    ["npm", "view", packageName, "version"],
    checkTimeout,
    "Could not check the latest foreman version",
    "Check your network and npm registry access, then retry. foreman update reads the registry through npm, so npm must be on PATH.",
  );
  const result = (
    action: (typeof UpdateResult.Type)["action"],
    command: string | null,
  ): typeof UpdateResult.Type => ({ current: host.version, latest, method, action, command });

  if (!isNewer(latest, host.version)) return result("current", null);
  const install = installCommands[method];
  if (!install) return result("manual", null);
  const command = [...install, `${packageName}@${latest}`];
  if (options.check) return result("available", command.join(" "));
  yield* run(
    command,
    installTimeout,
    `Could not install foreman ${latest}`,
    "Fix the cause shown above, then run foreman update again; the installed version is unchanged if the install did not finish.",
  );
  return result("updated", command.join(" "));
});
