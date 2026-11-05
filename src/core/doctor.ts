import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { checkProtocol, codexVersion } from "../codex/check";
import { AppConfig } from "../config";
import { call } from "../daemon/client";
import { errorTable } from "../errors";
import type { DoctorResult } from "../schemas/doctor";
import { Host } from "../services/host";

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

export const doctor = Effect.fn("doctor")(function* () {
  const config = yield* AppConfig;
  const host = yield* Host;
  const settings = yield* config.load.pipe(
    Effect.map((value) => ({ greeting: value.greeting, configError: null })),
    Effect.catch((error) =>
      Effect.succeed({ greeting: null, configError: errorTable[error._tag].message }),
    ),
  );
  yield* Effect.logDebug("configuration checked");
  if (settings.configError) yield* Effect.logWarning("configuration unavailable");
  const env = { CODEX_HOME: config.codexHome };
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
    configFile: config.configFile,
    dataDir: config.dataDir,
    codexVersion: version,
    protocolMatches,
    loggedIn,
    daemon: yield* daemonState(config.dataDir),
    ...settings,
  } satisfies typeof DoctorResult.Type;
});
