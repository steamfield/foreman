/**
 * The in-memory live state a provider event updates on a run: the open item, the latest
 * commentary, subagents and whether a project hook has run this turn.
 *
 * Plain mutations of `Run`; each returns whether the change is visible, so the caller can
 * wake waiters.
 */
import type { ProviderEvent, SubAgentActivity } from "../providers/contract";
import type { Run, SubAgentState } from "./registry";

type EventOf<Tag extends ProviderEvent["_tag"]> = Extract<ProviderEvent, { _tag: Tag }>;

/** Subagent activity kinds that change a subagent; others describe the same item again. */
const FOLDED_KINDS: ReadonlySet<string> = new Set(["started", "interacted", "completed"]);

/** Records the item as the run's open item. */
export function openItem(run: Run, event: EventOf<"ItemStarted">, now: number): boolean {
  run.openItem = { id: event.id, type: event.type, command: event.command, startedAt: now };
  return true;
}

/** Clears the open item when the completed item is the one that was open. */
export function closeItem(run: Run, event: EventOf<"ItemCompleted">): boolean {
  if (run.openItem?.id !== event.item.id) return false;
  run.openItem = null;
  return true;
}

/** Keeps the latest agent message that isn't the final answer as the run's commentary. */
export function noteCommentary(run: Run, event: EventOf<"AgentMessage">, now: number): boolean {
  if (event.phase === "final_answer") return false;
  run.lastCommentary = { text: event.text, at: now };
  return true;
}

function newSubAgent(activity: SubAgentActivity, at: number): SubAgentState {
  return {
    threadId: activity.threadId,
    path: activity.path,
    model: null,
    effort: null,
    state: "working",
    startedAt: at,
    lastInteractionAt: at,
    interactions: 0,
  };
}

/** Folds a completed subagent activity item into the run's subagents. */
export function foldSubAgent(run: Run, event: EventOf<"SubAgent">, now: number): boolean {
  const { activity } = event;
  if (!FOLDED_KINDS.has(activity.kind)) return false;
  const at = activity.startedAtMs ?? now;
  let agent = run.subagents.get(activity.threadId);
  if (!agent) {
    agent = newSubAgent(activity, at);
    run.subagents.set(activity.threadId, agent);
  }
  if (activity.kind === "started") {
    agent.model ??= activity.model;
    agent.effort ??= activity.effort;
  } else if (activity.kind === "interacted") {
    agent.state = "working";
    agent.interactions += 1;
    agent.lastInteractionAt = at;
  } else agent.state = "idle";
  return true;
}

/** Notes that a project hook ran this turn, which satisfies the repo hook rule. */
export function noteHook(run: Run, event: EventOf<"HookStarted">): boolean {
  if (event.project) run.projectHook = true;
  return false;
}

/** Ends the turn's live state: nothing is open and every subagent is idle. */
export function endTurn(run: Run): void {
  run.openItem = null;
  for (const agent of run.subagents.values()) agent.state = "idle";
}
