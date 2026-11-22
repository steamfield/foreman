/**
 * The agy `Provider`: `agy acp` (Agent Client Protocol over stdio) with foreman answering
 * agy's permission requests. Wiring only: names and capabilities, the filtered environment,
 * the version warning from the last handshake, repo hook checks and how to connect.
 * docs/rfcs/0002-providers.md "The agy adapter" is the design.
 */
import { Context, Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { probeSsh } from "../../core/preflight/ssh";
import { AgyUnavailable } from "../../errors";
import type { Provider } from "../contract";
import { connectAgy } from "./connection";
import { agyEnvironment } from "./environment";
import { findAgyHooks } from "./hooks";

/** The agy release and ACP version this foreman was verified against. */
export const supportedAgy = { version: "1.5.14", protocolVersion: 1 } as const;

/** The model an agy run uses when the start names none. */
const DEFAULT_MODEL = "gemini-4-neon";

/** What the agy provider needs from configuration. */
export interface AgyProviderOptions {
  readonly agyBin: string;
  /** foreman's home: logs, the model cache and agy's launch directory live under it. */
  readonly home: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  /** foreman's version, sent in the initialize handshake. */
  readonly version: string;
}

/** The services agy's probes and child process need. */
export type AgyRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Words the agy version from the last handshake as a warning for new runs. null when it is the
 * verified version, or when agy hasn't started yet and nothing is known.
 */
export function versionWarning(agyBin: string, agentVersion: string | null | undefined) {
  if (agentVersion === undefined || agentVersion === supportedAgy.version) return null;
  const action = `Install agy ${supportedAgy.version} or correct AGY_BIN, then run foreman doctor to check compatibility.`;
  const found = agentVersion === null ? "reported no version" : `is version ${agentVersion}`;
  return `agy ${JSON.stringify(agyBin)} ${found}; compatibility is unverified. ${action}`;
}

/**
 * Builds the agy provider. Building never starts agy; the environment (with its SSH probe) is
 * computed once, on first use.
 */
export const makeAgyProvider = Effect.fn("agy.provider")(function* (options: AgyProviderOptions) {
  // Only these services: a captured Scope would take ownership of the child from the caller's.
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    ChildProcessSpawner.ChildProcessSpawner,
  )(yield* Effect.context<AgyRequirements>());
  const environment = yield* Effect.cached(
    probeSsh(options.inheritedEnvironment).pipe(
      Effect.map((ssh) => agyEnvironment(options.inheritedEnvironment, ssh)),
      Effect.provide(context),
    ),
  );
  // undefined until a connection completes its handshake.
  let agentVersion: string | null | undefined;
  const provider: Provider = {
    id: "agy",
    displayName: "agy",
    binary: options.agyBin,
    capabilities: { serviceTier: false, hookEvents: false },
    environment,
    compatibilityWarning: Effect.sync(() => versionWarning(options.agyBin, agentVersion)),
    defaultModel: Effect.succeed(DEFAULT_MODEL),
    unavailable: (detail) => new AgyUnavailable({ detail }),
    // agy loads hooks from the worktree it runs in, not the main checkout.
    hasRepoHooks: (_mainCheckout, worktree) =>
      findAgyHooks(worktree).pipe(
        Effect.map((path) => path !== null),
        Effect.provide(context),
      ),
    hookBypassMessage: (group, worktree) =>
      `agy reports no hook runs, so foreman can't confirm the hooks in ${group}/.agents/hooks.json ran in ${worktree}.`,
    connect: (stderr) =>
      Effect.gen(function* () {
        const connected = yield* connectAgy({
          agyBin: options.agyBin,
          home: options.home,
          env: yield* environment,
          version: options.version,
          stderr,
        });
        agentVersion = connected.agentVersion;
        return connected.connection;
      }).pipe(Effect.provide(context)),
  };
  return provider;
});
