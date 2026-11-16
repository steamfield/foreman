import { Clock, Effect, Schema } from "effect";
import { QUIET_AFTER_MS } from "../core/monitor/attention";
import { hookTrustFix } from "../core/preflight/hooks";
import {
  type DecodedNotification,
  normalizeNotification,
  pickHandoff,
} from "../core/runs/normalize";
import * as Store from "../core/runs/store";
import * as Codex from "../schemas/codex";
import { activeStates } from "../schemas/daemon";
import type { AppServer } from "./app-server";
import type { Registry, Run } from "./registry";
import type { Turns } from "./turns";

function turnStatus(status: string): Codex.TurnStatus {
  switch (status) {
    case "inProgress":
    case "completed":
    case "interrupted":
      return status;
    default:
      return "failed";
  }
}

const decode = Effect.fnUntraced(function* (
  message: typeof Codex.RpcNotification.Type,
  minimal: () => void,
) {
  switch (message.method) {
    case Codex.Method.turnStarted:
    case Codex.Method.turnCompleted: {
      const params = yield* Schema.decodeUnknownEffect(Codex.TurnNotification)(message.params).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.sync(minimal).pipe(
            Effect.andThen(Effect.logWarning("supervisor.turn.minimal")),
            Effect.annotateLogs({ method: message.method }),
            Effect.andThen(
              Schema.decodeUnknownEffect(Codex.TurnNotificationMinimal)(message.params),
            ),
            Effect.map((minimal) => ({
              ...minimal,
              turn: { ...minimal.turn, error: null, items: [] },
            })),
          ),
        ),
      );
      // Normalize the fallback's open status without asserting it is a known Codex status.
      const turn = { ...params.turn, status: turnStatus(params.turn.status) };
      return { method: message.method, params: { ...params, turn } } satisfies DecodedNotification;
    }
    case Codex.Method.itemStarted:
    case Codex.Method.itemCompleted:
      return {
        method: message.method,
        params: yield* Schema.decodeUnknownEffect(Codex.ItemNotification)(message.params),
      } satisfies DecodedNotification;
    case Codex.Method.hookStarted:
    case Codex.Method.hookCompleted:
      return {
        method: message.method,
        params: yield* Schema.decodeUnknownEffect(Codex.HookNotification)(message.params),
      } satisfies DecodedNotification;
    case Codex.Method.tokenUsageUpdated:
      return {
        method: message.method,
        params: yield* Schema.decodeUnknownEffect(Codex.TokenUsageNotification)(message.params),
      } satisfies DecodedNotification;
    case Codex.Method.error:
      return {
        method: message.method,
        params: yield* Schema.decodeUnknownEffect(Codex.ErrorNotification)(message.params),
      } satisfies DecodedNotification;
    case Codex.Method.mcpStartupStatus:
      return {
        method: message.method,
        params: yield* Schema.decodeUnknownEffect(Codex.McpStartupNotification)(message.params),
      } satisfies DecodedNotification;
    default:
      return null;
  }
});

export const handleNotification = Effect.fn("supervisor.notification")(function* (
  registry: Registry,
  turns: Turns,
  run: Run,
  server: AppServer,
  message: typeof Codex.RpcNotification.Type,
) {
  const now = yield* Clock.currentTimeMillis;
  const resumed = run.lastActivityAt !== null && now - run.lastActivityAt >= QUIET_AFTER_MS;
  // Wake once after silence; ordinary deltas only refresh the activity clock.
  run.lastActivityAt = now;
  if (resumed) yield* registry.wake(run);
  yield* Store.appendCodexMessage(run.dir, message);
  if (message.method === Codex.Method.itemStarted) {
    const envelope = yield* Schema.decodeUnknownEffect(Codex.ItemNotificationMinimal)(
      message.params,
    ).pipe(Effect.result);
    if (envelope._tag === "Success" && run.record.state === "unknown" && !run.record.activeTurnId) {
      yield* registry.save(run, { activeTurnId: envelope.success.turnId });
      yield* registry.state(run, "running");
      yield* turns.armBudget(run, server);
    }
    const kind = yield* Schema.decodeUnknownEffect(Codex.ItemKind)(message.params).pipe(
      Effect.result,
    );
    if (
      kind._tag === "Success" &&
      kind.success.item.type === "commandExecution" &&
      run.hooksRequired &&
      !run.projectHook &&
      activeStates.has(run.record.state)
    ) {
      yield* turns.interrupt(run, server, "repo-hooks");
      yield* registry.save(run, {
        failure: {
          message: `repo hooks did not run in ${run.record.worktree}. Inspect ${run.record.group}/.codex/hooks.json. ${hookTrustFix(run.record.group)}`,
          codexErrorInfo: null,
        },
      });
      if (run.record.state === "waiting") yield* registry.state(run, "running");
    }
  }
  let issue: "minimal" | "invalid" | undefined;
  const notification = yield* decode(message, () => {
    issue = "minimal";
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.sync(() => {
        issue = "invalid";
      }).pipe(
        Effect.andThen(Effect.logWarning("supervisor.notification.invalid")),
        Effect.annotateLogs({ method: message.method }),
        Effect.as(null),
      ),
    ),
  );
  if (issue !== undefined) {
    const warning = `Codex ${message.method} notification ${issue === "minimal" ? "used a partial reply" : "could not be decoded"}; run foreman doctor to check compatibility.`;
    if (!run.record.warnings.includes(warning))
      yield* registry.save(run, { warnings: [...run.record.warnings, warning] });
  }
  if (!notification) {
    if (
      !message.method.endsWith("/delta") &&
      message.method !== "item/commandExecution/outputDelta" &&
      message.method !== "turn/moderationMetadata" &&
      message.method !== "turn/diff/updated"
    ) {
      yield* registry.event(run, { _tag: "Other", method: message.method });
      yield* Effect.logDebug("supervisor.notification.unknown").pipe(
        Effect.annotateLogs({ method: message.method }),
      );
    }
    return;
  }
  if (run.record.state === "unknown") {
    let turnId: string | null = null;
    if ("turn" in notification.params) turnId = notification.params.turn.id;
    else if ("turnId" in notification.params) turnId = notification.params.turnId;
    if (turnId) {
      yield* registry.save(run, { activeTurnId: turnId });
      yield* registry.state(run, "running");
    }
  }
  if (
    "turnId" in notification.params &&
    notification.params.turnId &&
    notification.params.turnId !== run.record.activeTurnId
  )
    return;
  if (run.record.activeTurnId && activeStates.has(run.record.state))
    yield* turns.armBudget(run, server);
  if (
    (notification.method === Codex.Method.turnStarted ||
      notification.method === Codex.Method.turnCompleted) &&
    run.record.activeTurnId &&
    notification.params.turn.id !== run.record.activeTurnId
  )
    return;
  const events = normalizeNotification(
    notification,
    run.record.turns,
    run.record.turnKind ?? "start",
  );
  for (const event of events) {
    yield* registry.event(run, event);
    if (event._tag === "TokenUsage") yield* registry.save(run, { tokens: event.totals });
  }
  switch (notification.method) {
    case Codex.Method.turnStarted:
      if (activeStates.has(run.record.state)) {
        yield* registry.save(run, { activeTurnId: notification.params.turn.id });
        yield* turns.armBudget(run, server);
        yield* registry.state(run, run.calls.size ? "waiting" : "running");
      }
      break;
    case Codex.Method.turnCompleted: {
      run.openItem = null;
      for (const agent of run.subagents.values()) agent.state = "idle";
      yield* registry.wake(run);
      yield* registry.cancelQuestions(run);
      const handoff = pickHandoff([...run.items, ...notification.params.turn.items]);
      if (handoff !== null) yield* registry.handoff(run, handoff);
      yield* registry.refreshWorktree(run);
      yield* registry.save(run, {
        activeTurnId: null,
        failure: run.record.failure ?? notification.params.turn.error,
      });
      if (run.budgetExpired && run.record.failure === null) {
        yield* turns.handoff(run, server);
        return;
      }
      let state: "idle" | "interrupted" | "failed" = "idle";
      if (run.record.failure !== null || notification.params.turn.status === "failed")
        state = "failed";
      else if (
        run.record.turnKind === "handoff" ||
        notification.params.turn.status === "interrupted"
      )
        state = "interrupted";
      yield* registry.state(run, state);
      break;
    }
    case Codex.Method.itemStarted: {
      const item = notification.params.item;
      run.openItem = {
        id: item.id,
        type: item.type,
        command: Schema.is(Codex.CommandExecutionItem)(item) ? item.command : null,
        startedAt: now,
      };
      yield* registry.wake(run);
      break;
    }
    case Codex.Method.itemCompleted: {
      const item = notification.params.item;
      if (run.openItem?.id === item.id) {
        run.openItem = null;
        yield* registry.wake(run);
      }
      if (Schema.is(Codex.AgentMessageItem)(item) && item.phase !== "final_answer") {
        run.lastCommentary = { text: item.text, at: now };
        yield* registry.wake(run);
      }
      // Fold on completion only: started/completed notifications describe the same item.
      if (
        Schema.is(Codex.SubAgentActivityItem)(item) &&
        (item.kind === "started" || item.kind === "interacted" || item.kind === "completed")
      ) {
        let agent = run.subagents.get(item.agentThreadId);
        if (!agent) {
          agent = {
            threadId: item.agentThreadId,
            path: item.agentPath,
            model: null,
            effort: null,
            state: "working",
            startedAt: item.startedAtMs,
            lastInteractionAt: item.startedAtMs,
            interactions: 0,
          };
          run.subagents.set(item.agentThreadId, agent);
        }
        if (item.kind === "started") {
          agent.model ??= item.model;
          agent.effort ??= item.reasoningEffort;
        } else if (item.kind === "interacted") {
          agent.state = "working";
          agent.interactions += 1;
          agent.lastInteractionAt = item.startedAtMs;
        } else agent.state = "idle";
        yield* registry.wake(run);
      }
      run.items.push(item);
      break;
    }
    case Codex.Method.hookStarted:
      if (notification.params.run.source === "project") run.projectHook = true;
      break;
    case Codex.Method.hookCompleted:
    case Codex.Method.tokenUsageUpdated:
    case Codex.Method.error:
    case Codex.Method.mcpStartupStatus:
      break;
  }
});
