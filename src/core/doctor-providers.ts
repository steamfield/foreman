/**
 * The agy half of `foreman doctor`: executable and version, sign-in, ACP protocol, hook trust
 * for the current repo and catalog size. Each check is a small program that turns a failure
 * into a finding (what happened, why, the next step) instead of failing doctor, and none of
 * them starts an agy session, so no conversation is created.
 */
import { Clock, Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/process";
import type { AppConfig } from "../config";
import { errorText } from "../errors";
import { readAgyCatalog } from "../providers/agy/catalog";
import { agyEnvironment } from "../providers/agy/environment";
import { agyHookTrust } from "../providers/agy/hooks";
import { launchAgy } from "../providers/agy/launch";
import { supportedAgy, versionWarning } from "../providers/agy/provider";
import type { AgyDoctor } from "../schemas/doctor";
import { mainCheckout as discoverMainCheckout } from "./main-checkout";
import { probeSsh } from "./preflight/ssh";
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

/**
 * Runs `agy --version`. A spawn failure means agy is not installed; a timeout or non-zero
 * exit leaves agy installed with an unknown version.
 */
const probeExecutable = Effect.fnUntraced(function* (agyBin: string, env: AgyEnvironment) {
  return yield* commandResult(
    ChildProcess.make(agyBin, ["--version"], { env, extendEnv: false }),
  ).pipe(
    Effect.timeout(AGY_PROBE_TIMEOUT),
    Effect.map((result) => ({
      installed: true,
      version: result.code === 0 ? result.stdout.trim() || null : null,
    })),
    Effect.catch((error) =>
      Effect.succeed({ installed: error._tag === "TimeoutError", version: null }),
    ),
  );
});

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
      Effect.succeed({
        value: { signedIn: error._tag === "TimeoutError" ? null : false, catalogSize: null },
        finding:
          error._tag === "TimeoutError"
            ? "agy models did not finish within 20 seconds. Run `agy models` yourself to see why, then run foreman doctor."
            : `Could not list agy models, so sign-in is unconfirmed. ${error.detail ?? errorText(error)}`,
      }),
    ),
  );
});

/** Starts `agy acp` and completes `initialize` only (no session), then closes it. */
const probeProtocol = Effect.fnUntraced(function* (
  settings: Settings,
  env: AgyEnvironment,
  foremanVersion: string,
) {
  return yield* launchAgy({
    agyBin: settings.agyBin,
    home: settings.home,
    env,
    version: foremanVersion,
    stderr: () => Effect.void,
  }).pipe(
    Effect.scoped,
    Effect.timeout(AGY_PROBE_TIMEOUT),
    Effect.map(
      ({ agentVersion }): Checked<{ matches: boolean | null; agentVersion: string | null }> => ({
        value: { matches: true, agentVersion },
        finding: versionWarning(settings.agyBin, agentVersion),
      }),
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

/** Whether agy's hooks in the current repo would let a start proceed. */
const probeHookTrust = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const mainCheckout = yield* discoverMainCheckout(cwd);
    if (mainCheckout === null) return hookCheck("not applicable", null);
    yield* agyHookTrust(mainCheckout, yield* fs.realPath(cwd));
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
  const ssh = yield* probeSsh(settings.inheritedEnvironment).pipe(
    Effect.orElseSucceed(() => ({ alive: false, launchdSocket: undefined })),
  );
  const env = agyEnvironment(settings.inheritedEnvironment, ssh);
  const executable = yield* probeExecutable(settings.agyBin, env);
  if (!executable.installed) return agyNotInstalled(settings.agyBin);
  const signIn = yield* probeSignIn(settings, env);
  const protocol = yield* probeProtocol(settings, env, foremanVersion);
  const hooks = yield* probeHookTrust(cwd);
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
