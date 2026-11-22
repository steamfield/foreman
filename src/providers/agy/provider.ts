/**
 * The agy `Provider`: `agy acp` (Agent Client Protocol over stdio) with foreman answering
 * agy's permission requests. docs/rfcs/0002-providers.md "The agy adapter" is the design.
 */
import { Effect, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AgyUnavailable } from "../../errors";
import type { Provider } from "../contract";

/** The agy release and ACP version this foreman was verified against. */
export const supportedAgy = { version: "1.5.14", protocolVersion: 1 } as const;

/** What the agy provider needs from configuration. */
export interface AgyProviderOptions {
  readonly agyBin: string;
  /** foreman's home: logs, the model cache and agy's launch directory live under it. */
  readonly home: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  /** foreman's version, sent in the initialize handshake. */
  readonly version: string;
}

const notImplemented = Effect.die(new Error("not implemented"));

/**
 * Builds the agy provider. Building never starts agy; the environment and the compatibility
 * warning are computed on first use.
 */
export const makeAgyProvider = (
  options: AgyProviderOptions,
): Effect.Effect<
  Provider,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.succeed({
    id: "agy",
    displayName: "agy",
    binary: options.agyBin,
    capabilities: { serviceTier: false, hookEvents: false },
    environment: notImplemented,
    compatibilityWarning: notImplemented,
    defaultModel: Effect.succeed("gemini-4-neon"),
    unavailable: (detail) => new AgyUnavailable({ detail }),
    hasRepoHooks: () => notImplemented,
    hookBypassMessage: () => "agy reports no hook runs",
    connect: () => notImplemented,
  });
