/**
 * agy's environment: the shared filter plus Gemini and Google credentials, so agy signs in
 * with its own keyring login and never bills an API key. Adds `AGY_DELEGATE=1`.
 */
import { providerEnvironment, type SshProbe } from "../environment";

const AGY_CREDENTIALS: ReadonlySet<string> = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "AGY_ADC_AUTH",
  "ANTIGRAVITY_PROJECT_ID",
]);

/** The environment `agy acp` and `agy models` run with. */
export function agyEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  ssh: SshProbe,
): Record<string, string> {
  return providerEnvironment(inherited, ssh, AGY_CREDENTIALS, { AGY_DELEGATE: "1" });
}
