import type { SshProbe } from "../environment";

/**
 * agy's environment: the shared filter plus Gemini and Google credentials, so agy signs in
 * with its own keyring login and never bills an API key. Adds `AGY_DELEGATE=1`.
 */
export function agyEnvironment(
  _inherited: Readonly<Record<string, string | undefined>>,
  _ssh: SshProbe,
): Record<string, string> {
  throw new Error("not implemented");
}
