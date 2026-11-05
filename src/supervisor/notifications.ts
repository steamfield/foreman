import { Effect, Schema } from "effect";
import {
  type DecodedNotification,
  normalizeNotification,
  pickHandoff,
} from "../core/runs/normalize";
import * as Store from "../core/runs/store";
import { computeWorktreeFields } from "../core/runs/worktree";
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

const decode = Effect.fnUntraced(function* (message: typeof Codex.RpcNotification.Type) {
  switch (message.method) {
    case Codex.Method.turnStarted:
    case Codex.Method.turnCompleted: {
      const params = yield* Schema.decodeUnknownEffect(Codex.TurnNotification)(message.params).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.logWarning("supervisor.turn.minimal", { method: message.method }).pipe(
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
  yield* Store.appendCodexMessage(run.dir, message);
  const notification = yield* decode(message).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.logWarning("supervisor.notification.invalid", { method: message.method }).pipe(
        Effect.as(null),
      ),
    ),
  );
  if (!notification) {
    if (!message.method.endsWith("/delta")) {
      yield* registry.event(run, { _tag: "Other", method: message.method });
      yield* Effect.logDebug("supervisor.notification.unknown", { method: message.method });
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
      yield* registry.cancelQuestions(run);
      const handoff = pickHandoff([...run.items, ...notification.params.turn.items]);
      if (handoff !== null) yield* Store.writeHandoff(run.dir, run.record.turns, handoff);
      run.worktree = yield* computeWorktreeFields(run.record.worktree, run.dir);
      yield* registry.save(run, {
        activeTurnId: null,
        failure: run.record.failure ?? notification.params.turn.error,
      });
      if (run.budgetExpired && run.record.failure === null) {
        yield* turns.handoff(run, server).pipe(
          Effect.catchTags({
            CodexRpcError: () =>
              Effect.logWarning("supervisor.handoff.refused", { name: run.record.name }),
            CodexUnavailable: () =>
              Effect.logWarning("supervisor.handoff.unavailable", { name: run.record.name }),
            SchemaError: () =>
              Effect.logWarning("supervisor.handoff.invalid", { name: run.record.name }),
          }),
        );
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
    case Codex.Method.itemStarted:
      if (
        notification.params.item.type === "commandExecution" &&
        run.hooksRequired &&
        !run.projectHook &&
        activeStates.has(run.record.state)
      ) {
        yield* turns.interrupt(run, server, "repo-hooks");
        yield* registry.save(run, {
          failure: { message: "repo hooks did not run", codexErrorInfo: null },
        });
        if (run.record.state === "waiting") yield* registry.state(run, "running");
      }
      break;
    case Codex.Method.itemCompleted:
      run.items.push(notification.params.item);
      break;
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
