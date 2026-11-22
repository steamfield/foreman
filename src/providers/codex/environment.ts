/** The caller probes SSH and supplies the launchd socket; this function performs no I/O. */
export function appServerEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  ssh: { alive: boolean; launchdSocket: string | undefined },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (
      value === undefined ||
      key.startsWith("CLAUDE_") ||
      key.startsWith("FOREMAN_") ||
      key === "LOG_LEVEL" ||
      key === "OPENAI_API_KEY" ||
      key === "OPENAI_API_BASE" ||
      key === "CODEX_API_KEY"
    )
      continue;
    env[key] = value;
  }
  env.CODEX_DELEGATE = "1";
  env.STACKS_DELEGATE = "1";
  if ((!env.SSH_AUTH_SOCK || !ssh.alive) && ssh.launchdSocket !== undefined) {
    env.SSH_AUTH_SOCK = ssh.launchdSocket;
  }
  return env;
}
