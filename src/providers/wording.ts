/**
 * How each provider's child process and diagnostic logs are named in messages about a lost or
 * unavailable connection. One table, so a message never calls agy an app server or sends the
 * reader to Codex's log. Pure.
 */
import type { ProviderId } from "../schemas/provider";

/** The words a message uses for one provider. */
export interface ProviderWording {
  /** What the supervisor talks to: Codex's "app server", or agy itself. */
  readonly server: string;
  /** The log files under foreman's home that explain a failure, as a phrase. */
  readonly logs: string;
}

const WORDING: Readonly<Record<ProviderId, ProviderWording>> = {
  codex: { server: "app server", logs: "logs/app-server.log" },
  agy: { server: "agy", logs: "logs/agy-acp.log and logs/agy-stderr.log" },
};

/**
 * The wording for a provider.
 * @throws Never; pure.
 */
export const wordingFor = (provider: ProviderId): ProviderWording => WORDING[provider];
