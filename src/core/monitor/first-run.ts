import { SAVED_PROBE_MS } from "./feed";
import { legendLines } from "./legend";

function probeSeconds(nextProbeAt: number | null, now: number): number | null {
  if (nextProbeAt === null) return null;
  const remaining = nextProbeAt - now;
  const next = remaining > 0 ? remaining : SAVED_PROBE_MS - ((now - nextProbeAt) % SAVED_PROBE_MS);
  return Math.ceil(next / 1000);
}

/** Explains delegation and the list vocabulary before the first run exists. */
export function firstRunLines(nextProbeAt: number | null, now: number): readonly string[] {
  const seconds = probeSeconds(nextProbeAt, now);
  return [
    "No runs on this machine yet.",
    "",
    "Runs are started by your coding agent. Ask it to delegate, for example:",
    "  “Use foreman to have Codex fix the flaky hook test.”",
    "",
    "Check this repo is ready     foreman doctor",
    "Teach your agent foreman     foreman skill install",
    "",
    "What you will see here",
    ...legendLines().map((line) => `  ${line}`),
    "  ━━━─── budget     time used of the turn's limit, not progress",
    ...(seconds === null
      ? []
      : ["", `This screen updates by itself. Checking for a daemon again in ${seconds}s.`]),
  ];
}
