import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { checkProtocol, codexVersion } from "../codex/check";
import { openConnection } from "../codex/client";
import { appServerEnvironment } from "../codex/environment";
import { AppConfig } from "../config";
import { call } from "../daemon/client";
import { errorTable } from "../errors";
import type { DoctorResult, RepoHookTrust } from "../schemas/doctor";
import { Host } from "../services/host";
import { formanExecutable } from "./command-output";
import { hasRepoHooks, inspectHookTrust } from "./preflight/hooks";

const probeTimeout = "5 seconds";

const daemonState = Effect.fnUntraced(
  function* (dataDir: string) {
    const result = yield* call({ _tag: "Ping" }, { dataDir, connectOnly: true });
    return result._tag === "Pong"
      ? { state: "running" as const, version: result.version, pid: result.pid }
      : { state: "not running" as const };
  },
  Effect.timeout(probeTimeout),
  Effect.orElseSucceed(() => ({ state: "not running" as const })),
);

const listWorktrees = Effect.fnUntraced(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
      env: { LC_ALL: "C" },
      extendEnv: true,
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "2 seconds",
    }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, code };
}, Effect.scoped);

const repoHookTrust = Effect.fnUntraced(function* (
  config: AppConfig["Service"],
  env: Readonly<Record<string, string>>,
  version: string,
  cwd: string,
) {
  let mainCheckout: string | null = null;
  return yield* Effect.gen(function* () {
    const listing = yield* listWorktrees(cwd);
    const first = listing.stdout.split("\0")[0];
    if (listing.code !== 0) {
      // Git uses exit 128 for both absence and failures such as corrupt configuration.
      const outsideRepo = listing.stderr.startsWith(
        "fatal: not a git repository (or any of the parent directories): .git",
      );
      return {
        state: outsideRepo ? "not applicable" : "unknown",
        mainCheckout,
        hooks: [],
        acceptsStart: null,
        detail: outsideRepo ? null : "Could not discover repo hooks: git worktree list failed.",
      } satisfies typeof RepoHookTrust.Type;
    }
    if (!first?.startsWith("worktree "))
      return {
        state: "unknown",
        mainCheckout,
        hooks: [],
        acceptsStart: null,
        detail: "Could not find main checkout.",
      } satisfies typeof RepoHookTrust.Type;
    const fs = yield* FileSystem.FileSystem;
    mainCheckout = yield* fs.realPath(first.slice("worktree ".length));
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
    Effect.catch(() =>
      Effect.succeed({
        state: "unknown" as const,
        mainCheckout,
        hooks: [],
        acceptsStart: null,
        detail: "Could not query Codex hook trust.",
      }),
    ),
  );
});

export const doctor = Effect.fn("doctor")(function* (cwd = ".") {
  const config = yield* AppConfig;
  const host = yield* Host;
  const settings = yield* config.load.pipe(
    Effect.as({ configError: null }),
    Effect.catch((error) => Effect.succeed({ configError: errorTable[error._tag].message })),
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
  return {
    name: host.name,
    version: host.version,
    platform: host.platform,
    compiled: host.compiled,
    formanOnPath: (yield* formanExecutable()).onPath,
    configFile: config.configFile,
    dataDir: config.dataDir,
    codexBin: config.codexBin,
    codexVersion: version,
    protocolMatches,
    loggedIn,
    daemon: yield* daemonState(config.dataDir),
    repoHooks: yield* repoHookTrust(config, env, host.version, cwd),
    ...settings,
  } satisfies typeof DoctorResult.Type;
});
