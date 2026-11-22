import { providerEnvironment, type SshProbe } from "../environment";

const CODEX_CREDENTIALS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "CODEX_API_KEY",
]);

/** The Codex app server's environment; it signs in with the Codex CLI's own login. */
export function appServerEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  ssh: SshProbe,
): Record<string, string> {
  return providerEnvironment(inherited, ssh, CODEX_CREDENTIALS, { CODEX_DELEGATE: "1" });
}
