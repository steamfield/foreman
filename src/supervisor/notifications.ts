/**
 * Applies one routed provider message to its run, under the run lock.
 *
 * In order: refresh the activity clock, append the raw message (if any) to the run's provider log,
 * enforce the repo hook rule on command starts, record decode warnings and unrecognized
 * messages, adopt the turn of a run in unknown state, drop events of a stale turn, arm the
 * budget, journal the events, then update run state. No wire decoding happens here.
 */
import { Clock, Effect, FileSystem } from "effect";
import { QUIET_AFTER_MS } from "../core/monitor/attention";
import * as Store from "../core/runs/store";
import type { Inbound, ProviderConnection, ProviderEvent, TurnId } from "../providers/contract";
import { activeStates, providerOf } from "../schemas/daemon";
import * as LiveState from "./live-state";
import type { Registry, Run } from "./registry";
import { toRunEvents } from "./run-events";
import { isStaleMessage } from "./stale";
import { changedSince, readSnapshot, type Turns } from "./turns";

/** What the supervisor knows about the provider that sent the message. */
export interface ProviderFacts {
  /** The provider reports project hook runs, so the repo hook rule can be enforced. */
  readonly hookEvents: boolean;
  /** The provider's name in run warnings ("Codex"). */
  readonly displayName: string;
  /** The run failure when a command started before any project hook ran. */
  readonly hookBypassMessage: (group: string, worktree: string) => string;
}

type EventOf<Tag extends ProviderEvent["_tag"]> = Extract<ProviderEvent, { _tag: Tag }>;

// Wake once after silence; ordinary deltas only refresh the activity clock.
const refreshActivity = Effect.fnUntraced(function* (registry: Registry, run: Run, now: number) {
  const resumed = run.lastActivityAt !== null && now - run.lastActivityAt >= QUIET_AFTER_MS;
  run.lastActivityAt = now;
  if (resumed) yield* registry.wake(run);
});

/** A run in unknown state that sees its first command start resumes on that turn. */
const adoptStartedTurn = Effect.fnUntraced(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  turn: TurnId,
) {
  if (run.record.state !== "unknown" || run.record.activeTurnId) return;
  yield* registry.save(run, { activeTurnId: turn });
  yield* registry.state(run, "running");
  yield* turns.armBudget(run, connection);
});

/** A command that starts before any project hook ran means the repo hooks were bypassed. */
const enforceRepoHooks = Effect.fnUntraced(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  facts: ProviderFacts,
) {
  if (!run.hooksRequired || run.projectHook || !activeStates.has(run.record.state)) return;
  yield* turns.interrupt(run, connection, "repo-hooks");
  yield* registry.save(run, {
    failure: {
      message: facts.hookBypassMessage(run.record.group, run.record.worktree),
      codexErrorInfo: null,
    },
  });
  if (run.record.state === "waiting") yield* registry.state(run, "running");
});

const commandStarts = Effect.fnUntraced(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  facts: ProviderFacts,
  started: EventOf<"ItemStarted">,
) {
  if (started.turn !== null)
    yield* adoptStartedTurn(registry, turns, run, connection, started.turn);
  if (started.kind === "command" && facts.hookEvents)
    yield* enforceRepoHooks(registry, turns, run, connection, facts);
});

const recordDecodeIssue = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  facts: ProviderFacts,
  issue: EventOf<"DecodeIssue">,
) {
  yield* Effect.logWarning(
    issue.issue === "minimal" ? "supervisor.turn.minimal" : "supervisor.notification.invalid",
  ).pipe(Effect.annotateLogs({ method: issue.method }));
  const warning = `${facts.displayName} ${issue.method} notification ${issue.issue === "minimal" ? "used a partial reply" : "could not be decoded"}; run foreman doctor to check compatibility.`;
  if (!run.record.warnings.includes(warning))
    yield* registry.save(run, { warnings: [...run.record.warnings, warning] });
});

/** A run in unknown state adopts the turn of the first event that names one. */
const adoptTurn = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  events: readonly ProviderEvent[],
) {
  if (run.record.state !== "unknown") return;
  const turn = events.find((event) => event.turn !== null)?.turn;
  if (!turn) return;
  yield* registry.save(run, { activeTurnId: turn });
  yield* registry.state(run, "running");
});

const journal = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  events: readonly ProviderEvent[],
) {
  const turnKind = run.record.turnKind ?? "start";
  for (const event of events)
    for (const body of toRunEvents(event, run.record.turns, turnKind)) {
      yield* registry.event(run, body);
      if (body._tag === "TokenUsage") yield* registry.save(run, { tokens: body.totals });
    }
});

const turnStarted = Effect.fnUntraced(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  event: EventOf<"TurnStarted">,
) {
  if (!activeStates.has(run.record.state)) return;
  yield* registry.save(run, { activeTurnId: event.turn });
  yield* turns.armBudget(run, connection);
  yield* registry.state(run, run.calls.size ? "waiting" : "running");
});

function completedState(run: Run, event: EventOf<"TurnCompleted">) {
  if (run.record.failure !== null || event.status === "failed") return "failed";
  if (run.record.turnKind === "handoff" || event.status === "interrupted") return "interrupted";
  return "idle";
}

/**
 * Compares the worktree with the snapshot taken when a checked read-only turn began; returns
 * the run failure when the turn changed files. Turns without a snapshot aren't checked.
 */
const checkReadOnlyTurn = Effect.fnUntraced(function* (registry: Registry, run: Run) {
  const before = run.turnSnapshot;
  run.turnSnapshot = null;
  if (before === null) return null;
  const fs = yield* FileSystem.FileSystem;
  // A removed worktree has nothing left to check; the digest reports the removal.
  if (!(yield* fs.exists(run.record.worktree))) return null;
  const changed = changedSince(before, yield* readSnapshot(run.record.worktree));
  if (changed.length === 0) return null;
  const message = `read-only ${providerOf(run.record)} run changed files: ${changed.join(", ")}`;
  if (!run.record.warnings.includes(message))
    yield* registry.save(run, { warnings: [...run.record.warnings, message] });
  return { message, codexErrorInfo: null };
});

const turnCompleted = Effect.fnUntraced(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  event: EventOf<"TurnCompleted">,
) {
  LiveState.endTurn(run);
  yield* registry.wake(run);
  yield* registry.cancelQuestions(run);
  if (event.handoff !== null) yield* registry.handoff(run, event.handoff);
  yield* registry.refreshWorktree(run);
  const readOnlyFailure = yield* checkReadOnlyTurn(registry, run);
  yield* registry.save(run, {
    activeTurnId: null,
    // The provider's own reason comes first; the changed paths are always in the warnings.
    failure: run.record.failure ?? event.failure ?? readOnlyFailure,
  });
  // A working turn ended by its budget gets a hand-off turn instead of a final state.
  if (run.budgetExpired && run.record.failure === null)
    return yield* turns.handoff(run, connection);
  yield* registry.state(run, completedState(run, event));
});

/** Updates live state for one event; returns whether waiters should wake. */
function updateLiveState(run: Run, event: ProviderEvent, now: number): boolean {
  switch (event._tag) {
    case "ItemStarted":
      return LiveState.openItem(run, event, now);
    case "ItemCompleted":
      return LiveState.closeItem(run, event);
    case "AgentMessage":
      return LiveState.noteCommentary(run, event, now);
    case "SubAgent":
      return LiveState.foldSubAgent(run, event, now);
    case "HookStarted":
      return LiveState.noteHook(run, event);
    default:
      return false;
  }
}

const applyEvent = Effect.fnUntraced(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  event: ProviderEvent,
  now: number,
) {
  if (event._tag === "TurnStarted")
    return yield* turnStarted(registry, turns, run, connection, event);
  if (event._tag === "TurnCompleted")
    return yield* turnCompleted(registry, turns, run, connection, event);
  if (updateLiveState(run, event, now)) yield* registry.wake(run);
});

const recordUnrecognized = Effect.fnUntraced(function* (
  registry: Registry,
  run: Run,
  method: string,
) {
  yield* registry.event(run, { _tag: "Other", method });
  yield* Effect.logDebug("supervisor.notification.unknown").pipe(Effect.annotateLogs({ method }));
});

/** Applies one inbound message to its run; called with the run lock held. */
export const handleNotification = Effect.fn("supervisor.notification")(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  connection: ProviderConnection,
  facts: ProviderFacts,
  inbound: Inbound,
) {
  const now = yield* Clock.currentTimeMillis;
  yield* refreshActivity(registry, run, now);
  // A synthesized message (raw null) has nothing to log.
  if (inbound.raw !== null)
    yield* Store.appendProviderMessage(run.dir, providerOf(run.record), inbound.raw);
  const { events } = inbound;
  for (const event of events)
    if (event._tag === "ItemStarted")
      yield* commandStarts(registry, turns, run, connection, facts, event);
  for (const event of events)
    if (event._tag === "DecodeIssue") yield* recordDecodeIssue(registry, run, facts, event);
  const unrecognized = events.find((event) => event._tag === "Unrecognized");
  if (unrecognized) return yield* recordUnrecognized(registry, run, unrecognized.method);
  if (events.length > 0 && events.every((event) => event._tag === "Activity")) return;
  yield* adoptTurn(registry, run, events);
  if (isStaleMessage(events, run.record.activeTurnId)) return;
  if (run.record.activeTurnId && activeStates.has(run.record.state))
    yield* turns.armBudget(run, connection);
  yield* journal(registry, run, events);
  for (const event of events) yield* applyEvent(registry, turns, run, connection, event, now);
});
