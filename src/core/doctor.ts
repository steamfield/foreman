import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import { checkProtocol, codexVersion } from "../codex/check";
import { openConnection } from "../codex/client";
import { appServerEnvironment } from "../codex/environment";
import { AppConfig } from "../config";
import { probe } from "../daemon/client";
import {
  CodexUnavailable,
  errorText,
  PermissionDenied,
  RepoHooksUntrusted,
  WorktreeInvalid,
} from "../errors";
import type { DoctorResult, RepoHookTrust } from "../schemas/doctor";
import { Host } from "../services/host";
import { foremanExecutable } from "./command-output";
import { mainCheckout as discoverMainCheckout } from "./main-checkout";
import { orphanWorktrees } from "./managed-worktree";
import { hasRepoHooks, inspectHookTrust } from "./preflight/hooks";
import { readAllRuns } from "./runs/store";

const probeTimeout = "5 seconds";

const daemonState = Effect.fnUntraced(
  function* (dataDir: string) {
    const host = yield* Host;
    const result = yield* probe(dataDir);
    if (result === null) return { state: "not running" as const };
    return result._tag === "Pong"
      ? {
          state: "running" as const,
          version: result.version,
          pid: result.pid,
          build: result.build ?? null,
          buildMatches: result.build === undefined ? null : result.build === host.build,
        }
      : { state: "unavailable" as const, detail: "Daemon returned an unexpected Ping reply." };
  },
  Effect.timeout(probeTimeout),
  Effect.catch((error) => {
    let detail = "Could not query daemon; reply was unreadable.";
    if (error._tag === "TimeoutError") detail = "Daemon Ping timed out after 5 seconds.";
    if (error._tag === "DaemonUnavailable") detail = error.detail ?? "Could not query daemon.";
    if (error._tag === "PermissionDenied")
      detail = error.detail ?? "Could not access daemon socket.";
    return Effect.succeed({ state: "unavailable" as const, detail });
  }),
);

const homePermissions = Effect.fnUntraced(
  function* (home: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let target = home;
    let info = yield* fs
      .stat(target)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    while (info === null && path.dirname(target) !== target) {
      target = path.dirname(target);
      info = yield* fs
        .stat(target)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    }
    const result = (
      state: typeof DoctorResult.Type.homePermissions.state,
      detail: string | null,
    ) => ({ state, path: home, detail });
    if (info === null || info.type !== "Directory")
      return result(
        "unusable",
        `Home or parent is not a directory: ${target}. Choose a directory for FOREMAN_HOME.`,
      );
    const access = yield* fs.access(target, { readable: true, writable: true }).pipe(Effect.result);
    const searchable = yield* spawner.exitCode(
      ChildProcess.make("/bin/test", ["-x", target], { stdout: "ignore", stderr: "ignore" }),
    );
    if (access._tag === "Failure" || searchable !== 0)
      return result(
        "unusable",
        `Home or parent needs read, write and search access: ${target}. Correct its permissions or choose another FOREMAN_HOME.`,
      );
    if (target !== home)
      return result(
        "missing",
        `Normal before first use: the daemon creates it on the first run command, such as \`foreman status\`. Its parent ${target} is writable.`,
      );
    const uid = yield* spawner
      .string(ChildProcess.make("/usr/bin/id", ["-u"]))
      .pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(Schema.NumberFromString)(value.trim()),
        ),
      );
    if (Option.isNone(info.uid)) return result("unknown", "Could not determine home ownership.");
    if (info.uid.value !== uid)
      return result(
        "unsafe",
        "Home is owned by another user. Choose a FOREMAN_HOME owned by your user or correct its ownership.",
      );
    if ((info.mode & 0o077) !== 0)
      return result(
        "unsafe",
        `Home is accessible to other users. Run ${CommandLine.display(["chmod", "700", home])} to make it private.`,
      );
    return result("ok", null);
  },
  (effect, home) =>
    effect.pipe(
      Effect.timeout(probeTimeout),
      Effect.catch(() =>
        Effect.succeed({
          state: "unknown" as const,
          path: home,
          detail:
            "Could not inspect home ownership or permissions; check access to the home and its parents.",
        }),
      ),
    ),
);

const repoHookTrust = Effect.fnUntraced(function* (
  config: AppConfig["Service"],
  env: Readonly<Record<string, string>>,
  version: string,
  cwd: string,
) {
  let mainCheckout: string | null = null;
  return yield* Effect.gen(function* () {
    mainCheckout = yield* discoverMainCheckout(cwd);
    if (mainCheckout === null) {
      return {
        state: "not applicable",
        mainCheckout,
        hooks: [],
        acceptsStart: null,
        detail: null,
      } satisfies typeof RepoHookTrust.Type;
    }
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* hasRepoHooks(mainCheckout)))
      return {
        state: "not applicable",
        mainCheckout,
        hooks: [],
        acceptsStart: null,
        detail: null,
      } satisfies typeof RepoHookTrust.Type;
    const connection = yield* openConnection({
      codexBin: config.codexBin,
      env,
      version,
      stderr: () => Effect.void,
    });
    return {
      state: "known",
      mainCheckout,
      ...(yield* inspectHookTrust(connection, mainCheckout, yield* fs.realPath(cwd))),
    } satisfies typeof RepoHookTrust.Type;
  }).pipe(
    Effect.scoped,
    Effect.timeout(probeTimeout),
    Effect.catch((error) =>
      Effect.succeed({
        state: "unknown" as const,
        mainCheckout,
        hooks: [],
        acceptsStart: null,
        detail:
          error instanceof WorktreeInvalid ||
          error instanceof PermissionDenied ||
          error instanceof RepoHooksUntrusted ||
          error instanceof CodexUnavailable
            ? (error.detail ?? errorText(error))
            : `Could not query Codex hook trust for ${mainCheckout ?? cwd} using ${JSON.stringify(config.codexBin)} (${error._tag}). Check Codex availability and version, then retry foreman doctor.`,
      }),
    ),
  );
});

export const doctor = Effect.fn("doctor")(function* (cwd = ".") {
  const config = yield* AppConfig;
  const host = yield* Host;
  const settings = yield* config.load.pipe(
    Effect.as({ configError: null }),
    Effect.catch((error) => Effect.succeed({ configError: errorText(error) })),
  );
  yield* Effect.logDebug("configuration checked");
  if (settings.configError) yield* Effect.logWarning("configuration unavailable");
  const env = appServerEnvironment(
    { ...config.inheritedEnvironment, CODEX_HOME: config.codexHome },
    { alive: true, launchdSocket: undefined },
  );
  const version = yield* Effect.scoped(codexVersion(config.codexBin, env)).pipe(
    Effect.timeout(probeTimeout),
    Effect.orElseSucceed(() => null),
  );
  const protocolMatches = yield* Effect.scoped(checkProtocol(config.codexBin, env)).pipe(
    Effect.timeout(probeTimeout),
    Effect.map((result) => result.matches),
    Effect.orElseSucceed(() => null),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const loggedIn = yield* spawner
    .exitCode(
      ChildProcess.make(config.codexBin, ["login", "status"], {
        env,
        extendEnv: false,
        stdout: "ignore",
        stderr: "ignore",
        forceKillAfter: "2 seconds",
      }),
    )
    .pipe(
      Effect.timeout(probeTimeout),
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => null),
    );
  const worktrees = yield* Effect.gen(function* () {
    const records = yield* readAllRuns(config.home);
    return yield* orphanWorktrees(cwd, records.runs);
  }).pipe(Effect.timeout(probeTimeout), Effect.result);
  let orphanFields: Pick<typeof DoctorResult.Type, "orphans" | "orphanError"> = {};
  if (worktrees._tag === "Failure")
    orphanFields = {
      orphanError: "Could not inspect orphan worktrees; check Git and run data permissions.",
    };
  else if (worktrees.success.length > 0) orphanFields = { orphans: worktrees.success };
  return {
    ...orphanFields,
    name: host.name,
    version: host.version,
    platform: host.platform,
    compiled: host.compiled,
    foremanOnPath: (yield* foremanExecutable()).onPath,
    configFile: config.configFile,
    home: config.home,
    homePermissions: yield* homePermissions(config.home),
    codexBin: config.codexBin,
    codexVersion: version,
    protocolMatches,
    loggedIn,
    daemon: yield* daemonState(config.home),
    repoHooks: yield* repoHookTrust(config, env, host.version, cwd),
    ...settings,
  } satisfies typeof DoctorResult.Type;
});
