/**
 * The agy half of `foreman doctor`: executable and version, sign-in, ACP protocol, hook trust
 * for the current repo and catalog size. Each check is a small program that turns a failure
 * into a finding (what happened, why, the next step) instead of failing doctor, and none of
 * them starts an agy session, so no conversation is created.
 */
import { Clock, Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import type { AppConfig } from "../config";
import { errorText, WorktreeInvalid } from "../errors";
import { readAgyCatalog } from "../providers/agy/catalog";
import { agyEnvironment } from "../providers/agy/environment";
import { agyHookTrust } from "../providers/agy/hooks";
import { ACP_PROTOCOL_VERSION, mentionsAuth, startAgy } from "../providers/agy/launch";
import { supportedAgy, versionWarning } from "../providers/agy/provider";
import type { AgyDoctor } from "../schemas/doctor";
import { mainCheckout as discoverMainCheckout } from "./main-checkout";
import { commandResult } from "./process";

// agy's first start can take a few seconds (keyring, network), so its probes get longer than
// the Codex ones.
const AGY_PROBE_TIMEOUT = "20 seconds";

type AgyEnvironment = Record<string, string>;
type Settings = Pick<AppConfig["Service"], "agyBin" | "home" | "inheritedEnvironment">;
type HookTrust = typeof AgyDoctor.Type.hookTrust;

/** A check's outcome: the value to report and the finding to show, when there is one. */
interface Checked<A> {
  readonly value: A;
  readonly finding: string | null;
}

/**
 * The result for a machine without agy.
 * @throws Never.
 */
export function agyNotInstalled(agyBin: string): typeof AgyDoctor.Type {
  return {
    installed: false,
    bin: agyBin,
    version: null,
    signedIn: null,
    protocolMatches: null,
    agentVersion: null,
    hookTrust: "not applicable",
    catalogSize: null,
    findings: [
      `Could not run ${JSON.stringify(agyBin)}. Install agy or set AGY_BIN to enable Gemini models; Codex runs are unaffected.`,
    ],
  };
}

/** The result for an agy that is installed but didn't answer `agy --version` in time. */
function agyUnresponsive(agyBin: string): typeof AgyDoctor.Type {
  return {
    ...agyNotInstalled(agyBin),
    installed: true,
    hookTrust: "unknown",
    findings: [
      `agy --version did not finish within 20 seconds, so no other agy check ran. Run \`${agyBin} --version\` yourself to see why, then run foreman doctor.`,
    ],
  };
}

/**
 * Runs `agy --version`. A spawn failure means agy is not installed; a timeout means it hangs;
 * a non-zero exit leaves agy installed with an unknown version.
 */
const probeExecutable = Effect.fnUntraced(function* (agyBin: string, env: AgyEnvironment) {
  return yield* commandResult(
    ChildProcess.make(agyBin, ["--version"], { env, extendEnv: false }),
  ).pipe(
    Effect.timeout(AGY_PROBE_TIMEOUT),
    Effect.map((result) => ({
      state: "installed" as const,
      version: result.code === 0 ? result.stdout.trim() || null : null,
    })),
    Effect.catch((error) =>
      Effect.succeed({
        state: error._tag === "TimeoutError" ? ("unresponsive" as const) : ("missing" as const),
        version: null,
      }),
    ),
  );
});

/** The finding and sign-in value for a failed `agy models`; only an auth failure is "signed out". */
function signInFailure(detail: string): Checked<{ signedIn: false | null; catalogSize: null }> {
  const signedOut = mentionsAuth(detail);
  return {
    value: { signedIn: signedOut ? false : null, catalogSize: null },
    finding: signedOut
      ? `agy isn't signed in. Run agy once and sign in, then run foreman doctor. (${detail})`
      : `Could not confirm agy's sign-in because \`agy models\` failed. ${detail}`,
  };
}

/** Sign-in and catalog size from `agy models`, which creates no conversation. */
const probeSignIn = Effect.fnUntraced(function* (settings: Settings, env: AgyEnvironment) {
  const now = yield* Clock.currentTimeMillis;
  return yield* readAgyCatalog({
    agyBin: settings.agyBin,
    env,
    home: settings.home,
    now,
    refresh: true,
  }).pipe(
    Effect.timeout(AGY_PROBE_TIMEOUT),
    Effect.map(
      (catalog): Checked<{ signedIn: boolean | null; catalogSize: number | null }> => ({
        value: { signedIn: true, catalogSize: catalog.models.length },
        finding: null,
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        signInFailure(
          error._tag === "TimeoutError"
            ? "`agy models` did not finish within 20 seconds. Run it yourself to see why."
            : (error.detail ?? errorText(error)),
        ),
      ),
    ),
  );
});

/** Starts `agy acp` and completes `initialize` only (no session), then closes it. */
const probeProtocol = Effect.fnUntraced(function* (
  settings: Settings,
  env: AgyEnvironment,
  foremanVersion: string,
) {
  return yield* startAgy({
    agyBin: settings.agyBin,
    home: settings.home,
    env,
    version: foremanVersion,
    stderr: () => Effect.void,
  }).pipe(
    Effect.scoped,
    Effect.timeout(AGY_PROBE_TIMEOUT),
    Effect.map(
      ({
        protocolVersion,
        agentVersion,
      }): Checked<{ matches: boolean | null; agentVersion: string | null }> =>
        protocolVersion === ACP_PROTOCOL_VERSION
          ? {
              value: { matches: true, agentVersion },
              finding: versionWarning(settings.agyBin, agentVersion),
            }
          : {
              value: { matches: false, agentVersion },
              finding: `agy speaks ACP protocol ${protocolVersion}; foreman supports ${ACP_PROTOCOL_VERSION}. Install agy ${supportedAgy.version} or a compatible version, then run foreman doctor.`,
            },
    ),
    Effect.catch((error) =>
      Effect.succeed({
        value: { matches: null, agentVersion: null },
        finding:
          error._tag === "TimeoutError"
            ? `agy acp did not answer initialize within 20 seconds. Check the agy version (foreman supports ${supportedAgy.version}), then run foreman doctor.`
            : (error.detail ?? errorText(error)),
      }),
    ),
  );
});

const hookCheck = (value: HookTrust, finding: string | null): Checked<HookTrust> => ({
  value,
  finding,
});

/** The real path of the worktree root containing `cwd`, which is where agy loads hooks from. */
const worktreeRoot = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* commandResult(
    ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd, env: { LC_ALL: "C" } }),
  );
  if (result.code !== 0)
    return yield* new WorktreeInvalid({
      detail: `git rev-parse --show-toplevel exited ${result.code} in ${cwd}. Check Git and repository permissions, then run foreman doctor.`,
    });
  return yield* fs.realPath(result.stdout.trim());
});

/** Whether agy's hooks in the current repo would let a start proceed. */
const probeHookTrust = Effect.fnUntraced(function* (cwd: string) {
  return yield* Effect.gen(function* () {
    const mainCheckout = yield* discoverMainCheckout(cwd);
    if (mainCheckout === null) return hookCheck("not applicable", null);
    yield* agyHookTrust(mainCheckout, yield* worktreeRoot(cwd));
    return hookCheck("accepted", null);
  }).pipe(
    Effect.timeout(AGY_PROBE_TIMEOUT),
    Effect.catch((error) =>
      Effect.succeed(
        hookCheck(
          error._tag === "RepoHooksUntrusted" ? "refused" : "unknown",
          "detail" in error && typeof error.detail === "string"
            ? error.detail
            : `agy hooks could not be checked in ${cwd} (${error._tag}). Check Git and repository permissions, then run foreman doctor.`,
        ),
      ),
    ),
  );
});

/**
 * Probes agy for `foreman doctor`. Never starts a session; every probe failure becomes a finding.
 * @throws Never.
 */
export const agyDoctor = Effect.fn("doctor.agy")(function* (
  settings: Settings,
  foremanVersion: string,
  cwd: string,
) {
  // agy models and acp initialize need no SSH agent, so skip the probe, as Codex doctor does.
  const env = agyEnvironment(settings.inheritedEnvironment, {
    alive: true,
    launchdSocket: undefined,
  });
  const executable = yield* probeExecutable(settings.agyBin, env);
  if (executable.state === "missing") return agyNotInstalled(settings.agyBin);
  if (executable.state === "unresponsive") return agyUnresponsive(settings.agyBin);
  const { signIn, protocol, hooks } = yield* Effect.all(
    {
      signIn: probeSignIn(settings, env),
      protocol: probeProtocol(settings, env, foremanVersion),
      hooks: probeHookTrust(cwd),
    },
    { concurrency: "unbounded" },
  );
  return {
    installed: true,
    bin: settings.agyBin,
    version: executable.version,
    signedIn: signIn.value.signedIn,
    protocolMatches: protocol.value.matches,
    agentVersion: protocol.value.agentVersion,
    hookTrust: hooks.value,
    catalogSize: signIn.value.catalogSize,
    findings: [signIn.finding, protocol.finding, hooks.finding].filter(
      (finding): finding is string => finding !== null,
    ),
  } satisfies typeof AgyDoctor.Type;
});
