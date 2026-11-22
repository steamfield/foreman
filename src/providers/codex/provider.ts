/**
 * The Codex `Provider`: its capabilities, the app-server environment, the protocol
 * compatibility warning and how to connect. Wiring only; each piece lives in its own module.
 */
import { Effect, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { probeSsh } from "../../core/preflight/ssh";
import { CodexUnavailable } from "../../errors";
import type { Provider } from "../contract";
import { checkProtocol } from "./check";
import { connectCodex } from "./connection";
import { appServerEnvironment } from "./environment";
import { supportedCodex } from "./protocol";

const PROTOCOL_PROBE_TIMEOUT = "5 seconds";

/** What the Codex provider needs from configuration. */
export interface CodexProviderOptions {
  readonly codexBin: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  /** foreman's version, sent in the initialize handshake. */
  readonly version: string;
}

/** The services Codex's probes and child processes need. */
export type CodexRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/** Words the outcome of the protocol probe as a warning for new runs, or null when it matches. */
function protocolWarning(
  codexBin: string,
  probe: { readonly matches: boolean } | CodexUnavailable | "timeout",
): string | null {
  const action = `Install Codex ${supportedCodex.version} or correct CODEX_BIN, then run foreman doctor to check compatibility.`;
  if (probe === "timeout" || probe instanceof CodexUnavailable) {
    const reason =
      probe === "timeout" ? "probe timed out after 5 seconds" : (probe.detail ?? "unavailable");
    return `Could not check the Codex protocol for ${JSON.stringify(codexBin)}: ${reason}. ${action}`;
  }
  if (probe.matches) return null;
  return `Codex protocol differs from the supported version for ${JSON.stringify(codexBin)}; compatibility is unverified. ${action}`;
}

/**
 * Builds the Codex provider. The environment (with its SSH probe) and the protocol warning
 * are computed once, on first use.
 */
export const makeCodexProvider = Effect.fn("codex.provider")(function* (
  options: CodexProviderOptions,
) {
  const environment = yield* Effect.cached(
    probeSsh(options.inheritedEnvironment).pipe(
      Effect.map((ssh) => appServerEnvironment(options.inheritedEnvironment, ssh)),
    ),
  );
  const compatibilityWarning = yield* Effect.cached(
    Effect.gen(function* () {
      const probe = yield* checkProtocol(options.codexBin, yield* environment).pipe(
        Effect.scoped,
        Effect.timeout(PROTOCOL_PROBE_TIMEOUT),
        Effect.catchTag("TimeoutError", () => Effect.succeed("timeout" as const)),
        Effect.catchTag("CodexUnavailable", (error) => Effect.succeed(error)),
      );
      return protocolWarning(options.codexBin, probe);
    }),
  );
  const provider: Provider<CodexRequirements> = {
    id: "codex",
    capabilities: { serviceTier: true, hookEvents: true },
    environment,
    compatibilityWarning,
    connect: (stderr) =>
      Effect.gen(function* () {
        return yield* connectCodex({
          codexBin: options.codexBin,
          env: yield* environment,
          version: options.version,
          stderr,
        });
      }),
  };
  return provider;
});
