// Build-time access to the recorded foreman runs in fixtures/runs/.
// scripts/capture-runs.mjs writes them; see that script for how they are scrubbed.
import fixCli from "../../fixtures/runs/fix-cli.json";
import fixDaemon from "../../fixtures/runs/fix-daemon.json";
import fixSupervisor from "../../fixtures/runs/fix-supervisor.json";
import fixWorktrees from "../../fixtures/runs/fix-worktrees.json";
import siteCommands from "../../fixtures/runs/site-commands.json";
import siteConsole from "../../fixtures/runs/site-console.json";
import siteE2e from "../../fixtures/runs/site-e2e.json";
import siteSession from "../../fixtures/runs/site-session.json";

/** foreman's run states, as `StateChanged` events report them. */
export type RunState =
  "starting" | "running" | "waiting" | "idle" | "failed" | "lost";

export type RunEvent =
  | { seq: number; t: number; kind: "state"; from: RunState; to: RunState }
  | {
      seq: number;
      t: number;
      kind: "turn-started";
      turn: number;
      turnKind: string;
    }
  | {
      seq: number;
      t: number;
      kind: "turn-completed";
      turn: number;
      status: string;
    }
  | { seq: number; t: number; kind: "message"; text: string }
  | {
      seq: number;
      t: number;
      kind: "command";
      command: string;
      exitCode: number | null;
      output: string;
    }
  | { seq: number; t: number; kind: "files"; paths: string[] }
  | { seq: number; t: number; kind: "question"; id: string; text: string }
  | {
      seq: number;
      t: number;
      kind: "question-resolved";
      id: string;
      resolution: "answered" | "auto-answered" | string;
    }
  | { seq: number; t: number; kind: "hook-blocked"; feedback: string };

export type QuestionRecord =
  | {
      _tag: "Asked";
      id: string;
      turn: number;
      kind: string;
      question: string;
      at: string;
      t: number;
    }
  | {
      _tag: "Resolved";
      id: string;
      resolution: string;
      text: string;
      at: string;
      t: number;
    };

/**
 * One recorded run. `t` on events and questions is milliseconds since the run was
 * created; `durationMs` runs from creation to the last state change.
 */
export interface Run {
  name: string;
  model: string;
  effort: string;
  tier: string;
  write: boolean;
  branch: string | null;
  baseCommit: string;
  createdAt: string;
  durationMs: number;
  tokens: {
    input: number;
    cachedInput: number;
    output: number;
    reasoningOutput: number;
  };
  /** The contract Claude wrote, as Codex received it. */
  contract: string;
  events: RunEvent[];
  questions: QuestionRecord[];
  /** Codex's hand-off for turn 1 (Markdown), or null when the turn left none. */
  handoff: string | null;
  /** `foreman status <name>` output, captured after the run. */
  digest: string;
}

/** The four delegates that fixed foreman's release blockers in parallel, from one commit. */
export const releaseRuns = [
  fixCli,
  fixDaemon,
  fixSupervisor,
  fixWorktrees,
] as Run[];

/** Delegates that built this page: command tabs (sol), hero replay and session diagram (astra), browser tests (terra). */
export const siteRuns = [
  siteCommands,
  siteConsole,
  siteSession,
  siteE2e,
] as Run[];

export function loadRun(name: string): Run {
  const run = [...releaseRuns, ...siteRuns].find((r) => r.name === name);
  if (!run) throw new Error(`No recorded run named ${name} in fixtures/runs/`);
  return run;
}
