/**
 * The Codex `Provider`: its names and capabilities, the app-server environment, the protocol
 * compatibility warning, the default model, repo hook checks and how to connect. Wiring only;
 * each piece lives in its own module.
 */
import { Context, Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { probeSsh } from "../../core/preflight/ssh";
import { CodexUnavailable } from "../../errors";
import type { Provider } from "../contract";
import { defaultModel } from "./catalog";
import { checkProtocol } from "./check";
import { connectCodex } from "./connection";
import { appServerEnvironment } from "./environment";
import { hasRepoHooks, hookTrustFix } from "./hooks";
import { supportedCodex } from "./protocol";

const PROTOCOL_PROBE_TIMEOUT = "5 seconds";

/** What the Codex provider needs from configuration. */
export interface CodexProviderOptions {
  readonly codexBin: string;
  /** Codex's home, where its model cache lives. */
  readonly codexHome: string;
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
 * are computed once, on first use. The provider keeps the services it was built with.
 */
export const makeCodexProvider = Effect.fn("codex.provider")(function* (
  options: CodexProviderOptions,
) {
  // Only these services: a captured Scope would take ownership of the child from the caller's.
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    ChildProcessSpawner.ChildProcessSpawner,
  )(yield* Effect.context<CodexRequirements>());
  const environment = yield* Effect.cached(
    probeSsh(options.inheritedEnvironment).pipe(
      Effect.map((ssh) => appServerEnvironment(options.inheritedEnvironment, ssh)),
      Effect.provide(context),
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
    }).pipe(Effect.provide(context)),
  );
  const provider: Provider = {
    id: "codex",
    displayName: "Codex",
    binary: options.codexBin,
    capabilities: { serviceTier: true, hookEvents: true, cancelsQuestionsBeforeInterrupt: false },
    environment,
    compatibilityWarning,
    defaultModel: defaultModel(options.codexHome).pipe(Effect.provide(context)),
    unavailable: (detail) => new CodexUnavailable({ detail }),
    // Codex resolves project hooks from the main checkout, not the worktree.
    hasRepoHooks: (mainCheckout) => hasRepoHooks(mainCheckout).pipe(Effect.provide(context)),
    hookBypassMessage: (group, worktree) =>
      `repo hooks did not run in ${worktree}. Inspect ${group}/.codex/hooks.json. ${hookTrustFix(group)}`,
    connect: (stderr) =>
      Effect.gen(function* () {
        return yield* connectCodex({
          codexBin: options.codexBin,
          env: yield* environment,
          version: options.version,
          stderr,
        });
      }).pipe(Effect.provide(context)),
  };
  return provider;
});
