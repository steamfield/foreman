/**
 * The environment every provider's child starts from: the daemon's inherited environment
 * without foreman's and Claude's own variables, plus the delegate markers and a working SSH
 * agent socket. Each provider adds the credentials it drops and its own marker.
 *
 * The caller probes SSH and supplies the launchd socket; nothing here performs I/O.
 */

/** What the caller learned about the SSH agent. */
export interface SshProbe {
  readonly alive: boolean;
  readonly launchdSocket: string | undefined;
}

/**
 * Filters the inherited environment for a provider child.
 * @param drop Exact variable names this provider must not see (its API keys, for example).
 * @param markers Variables to set, such as `CODEX_DELEGATE=1`.
 */
export function providerEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  ssh: SshProbe,
  drop: ReadonlySet<string>,
  markers: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (
      value === undefined ||
      key.startsWith("CLAUDE_") ||
      key.startsWith("FOREMAN_") ||
      key === "LOG_LEVEL" ||
      drop.has(key)
    )
      continue;
    env[key] = value;
  }
  Object.assign(env, markers, { STACKS_DELEGATE: "1" });
  if ((!env.SSH_AUTH_SOCK || !ssh.alive) && ssh.launchdSocket !== undefined) {
    env.SSH_AUTH_SOCK = ssh.launchdSocket;
  }
  return env;
}
