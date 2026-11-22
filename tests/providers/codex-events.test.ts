import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CodexTurnItems,
  decodeNotification,
  outputTail,
  pickHandoff,
} from "../../src/providers/codex/events";
import type { ProviderEvent } from "../../src/providers/contract";
import type { RpcNotification } from "../../src/providers/jsonrpc";
import * as Codex from "../../src/schemas/codex";

const messages = readFileSync(new URL("../fixtures/codex-0.166.0.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line): unknown => JSON.parse(line))
  // The recording also holds requests and responses; keep the notifications.
  .filter(Schema.is(Codex.RpcNotification));

const recorded = (method: string) => messages.filter((message) => message.method === method);
const first = (method: string) => {
  const [message] = recorded(method);
  if (message === undefined) throw new Error(`fixture has no ${method} notification`);
  return message;
};

const turnStarted = Schema.decodeUnknownSync(Codex.TurnNotification)(first("turn/started").params);
const threadId = turnStarted.threadId;
const turnId = turnStarted.turn.id;
const completedItems = recorded("item/completed").map((message) =>
  Schema.decodeUnknownSync(Codex.ItemNotification)(message.params),
);
const commandNotification = completedItems.find((message) =>
  Schema.is(Codex.CommandExecutionItem)(message.item),
);
const command = Schema.decodeUnknownSync(Codex.CommandExecutionItem)(commandNotification?.item);
const agentNotification = completedItems.find((message) =>
  Schema.is(Codex.AgentMessageItem)(message.item),
);
const agentMessage = Schema.decodeUnknownSync(Codex.AgentMessageItem)(agentNotification?.item);

const empty: CodexTurnItems = { items: [] };

function decode(message: RpcNotification, items: CodexTurnItems = empty) {
  return decodeNotification(message, items);
}

function eventsOf(message: RpcNotification): readonly ProviderEvent[] {
  return decode(message).inbound.events;
}

function itemCompleted(item: unknown): RpcNotification {
  return { method: "item/completed", params: { threadId, turnId, item } };
}

function itemStarted(item: unknown): RpcNotification {
  return { method: "item/started", params: { threadId, turnId, item } };
}

function turnCompleted(turn: Record<string, unknown>): RpcNotification {
  return {
    method: "turn/completed",
    params: { threadId, turn: { ...turnStarted.turn, ...turn } },
  };
}

const message = (text: string, phase: string | null) =>
  Schema.decodeUnknownSync(Codex.AgentMessageItem)({ type: "agentMessage", id: text, text, phase });

describe("Codex notification routing", () => {
  it("routes to the thread's session and keeps the method and raw message", () => {
    const raw = first("turn/started");
    expect(decode(raw).inbound).toEqual({
      session: threadId,
      method: "turn/started",
      raw,
      events: [{ _tag: "TurnStarted", turn: turnId }],
    });
  });

  it("routes a message without a thread id to no session", () => {
    const params = { threadId: null, name: "docs", status: "failed", error: "boom" };
    expect(decode({ method: "mcpServer/startupStatus/updated", params }).inbound).toEqual({
      session: null,
      method: "mcpServer/startupStatus/updated",
      raw: { method: "mcpServer/startupStatus/updated", params },
      events: [{ _tag: "McpStartupFailed", turn: null, server: "docs", error: "boom" }],
    });
    expect(decode({ method: "thread/started" }).inbound.session).toBeNull();
  });

  it.each([
    "item/agentMessage/delta",
    "item/reasoning/textDelta/delta",
    "item/commandExecution/outputDelta",
    "turn/moderationMetadata",
    "turn/diff/updated",
  ])("treats %s as activity", (method) => {
    expect(eventsOf({ method, params: { threadId, turnId, delta: "x" } })).toEqual([
      { _tag: "Activity", turn: turnId },
    ]);
  });

  it("reports an unknown method as unrecognized, near misses of activity included", () => {
    expect(eventsOf({ method: "thread/started", params: { threadId } })).toEqual([
      { _tag: "Unrecognized", turn: null, method: "thread/started" },
    ]);
    expect(eventsOf({ method: "item/deltas", params: { threadId, turnId } })).toEqual([
      { _tag: "Unrecognized", turn: turnId, method: "item/deltas" },
    ]);
  });
});

describe("Codex turn notifications", () => {
  it("maps recorded completion and interruption, keeping status and failure", () => {
    for (const raw of recorded("turn/completed")) {
      const params = Schema.decodeUnknownSync(Codex.TurnNotification)(raw.params);
      expect(eventsOf(raw)).toEqual([
        {
          _tag: "TurnCompleted",
          turn: params.turn.id,
          status: params.turn.status,
          failure: null,
          handoff: pickHandoff(params.turn.items),
        },
      ]);
    }
    const failure = { message: "capacity", codexErrorInfo: { serverOverloaded: {} } };
    expect(eventsOf(turnCompleted({ status: "failed", error: failure, items: [] }))).toEqual([
      { _tag: "TurnCompleted", turn: turnId, status: "failed", failure, handoff: null },
    ]);
  });

  it("falls back to the minimal turn shape and reports the partial decode", () => {
    const params = { threadId, turn: { id: turnId, status: "completed" } };
    expect(eventsOf({ method: "turn/started", params })).toEqual([
      { _tag: "DecodeIssue", turn: turnId, method: "turn/started", issue: "minimal" },
      { _tag: "TurnStarted", turn: turnId },
    ]);
    expect(eventsOf({ method: "turn/completed", params })).toEqual([
      { _tag: "DecodeIssue", turn: turnId, method: "turn/completed", issue: "minimal" },
      { _tag: "TurnCompleted", turn: turnId, status: "completed", failure: null, handoff: null },
    ]);
  });

  it("fails an unknown turn status and ends an in-progress one as completed", () => {
    const status = (value: string) =>
      eventsOf({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: value } },
      })[1];
    expect(status("cancelledByFutureCodex")).toMatchObject({ status: "failed" });
    expect(status("inProgress")).toMatchObject({ status: "completed" });
  });

  it("reports an undecodable turn notification as invalid only", () => {
    expect(eventsOf({ method: "turn/completed", params: { threadId, turn: {} } })).toEqual([
      { _tag: "DecodeIssue", turn: null, method: "turn/completed", issue: "invalid" },
    ]);
  });

  it("collects completed items, resets them on turn start and hands off from them", () => {
    let items = decode(first("turn/started"), { items: [message("stale", "final_answer")] }).items;
    expect(items).toEqual({ items: [] });
    items = decode(itemCompleted(message("answer", "final_answer")), items).items;
    items = decode(itemCompleted(message("later note", "commentary")), items).items;
    items = decode(itemCompleted({ type: "reasoning", id: "r" }), items).items;
    expect(items.items).toHaveLength(3);
    const completed = decode(turnCompleted({ status: "completed", items: [] }), items);
    expect(completed.inbound.events).toEqual([
      {
        _tag: "TurnCompleted",
        turn: turnId,
        status: "completed",
        failure: null,
        handoff: "answer",
      },
    ]);
    expect(completed.items).toBe(items);
  });

  it("includes the completed turn's own items in the hand-off", () => {
    const items = { items: [message("earlier", "final_answer")] };
    const done = turnCompleted({ status: "completed", items: [message("final", "final_answer")] });
    expect(decode(done, items).inbound.events).toMatchObject([{ handoff: "final" }]);
  });
});

describe("Codex item notifications", () => {
  it.each([
    [
      "commandExecution",
      "command",
      { command: "ls", status: "inProgress", aggregatedOutput: null, exitCode: null },
      "ls",
    ],
    ["fileChange", "fileChange", { changes: [] }, null],
    ["agentMessage", "agentMessage", { text: "", phase: null }, null],
    ["dynamicToolCall", "tool", { tool: "ask_orchestrator", status: "inProgress" }, null],
    ["mcpToolCall", "tool", {}, null],
    ["reasoning", "other", {}, null],
  ])("classifies a started %s as %s", (type, kind, fields, startedCommand) => {
    expect(eventsOf(itemStarted({ type, id: "item-1", ...fields }))).toEqual([
      { _tag: "ItemStarted", turn: turnId, id: "item-1", kind, type, command: startedCommand },
    ]);
  });

  it("still sees a command start whose item no longer decodes", () => {
    expect(eventsOf(itemStarted({ type: "commandExecution", id: "cmd" }))).toEqual([
      { _tag: "DecodeIssue", turn: turnId, method: "item/started", issue: "invalid" },
      {
        _tag: "ItemStarted",
        turn: turnId,
        id: "cmd",
        kind: "command",
        type: "commandExecution",
        command: null,
      },
    ]);
  });

  it("reports an item start without its envelope as invalid only", () => {
    expect(
      eventsOf({
        method: "item/started",
        params: { threadId, item: { type: "commandExecution" } },
      }),
    ).toEqual([{ _tag: "DecodeIssue", turn: null, method: "item/started", issue: "invalid" }]);
  });

  it("maps a recorded completed command", () => {
    expect(eventsOf(itemCompleted(command))).toEqual([
      {
        _tag: "ItemCompleted",
        turn: turnId,
        item: {
          kind: "command",
          id: command.id,
          command: command.command,
          status: "completed",
          exitCode: 0,
          outputTail: command.aggregatedOutput,
        },
      },
    ]);
  });

  it("keeps the last 2 KB of command output on UTF-8 boundaries and handles null", () => {
    const long = itemCompleted({ ...command, aggregatedOutput: `prefix${"é".repeat(1100)}x` });
    expect(eventsOf(long)).toMatchObject([{ item: { outputTail: `${"é".repeat(1023)}x` } }]);
    expect(eventsOf(itemCompleted({ ...command, aggregatedOutput: null }))).toMatchObject([
      { item: { outputTail: "" } },
    ]);
    expect(outputTail("short")).toBe("short");
  });

  it("maps file changes to their paths", () => {
    const files = {
      type: "fileChange",
      id: "files",
      changes: [{ path: "src/a.ts" }, { path: "b.ts" }],
    };
    expect(eventsOf(itemCompleted(files))).toEqual([
      {
        _tag: "ItemCompleted",
        turn: turnId,
        item: { kind: "fileChange", id: "files", paths: ["src/a.ts", "b.ts"] },
      },
    ]);
  });

  it("maps a recorded agent message with its phase, dropping unknown phases", () => {
    expect(eventsOf(itemCompleted(agentMessage))).toEqual([
      { _tag: "AgentMessage", turn: turnId, text: agentMessage.text, phase: "final_answer" },
    ]);
    expect(eventsOf(itemCompleted(message("note", "commentary")))).toMatchObject([
      { phase: "commentary" },
    ]);
    expect(eventsOf(itemCompleted(message("note", "futurePhase")))).toMatchObject([
      { phase: null },
    ]);
  });

  it("maps subagent activity, defaulting unrecorded details to null", () => {
    const base = {
      type: "subAgentActivity",
      id: "s",
      kind: "started",
      agentThreadId: "t2",
      agentPath: "/a",
    };
    expect(
      eventsOf(itemCompleted({ ...base, model: "gpt", reasoningEffort: "high", startedAtMs: 5 })),
    ).toEqual([
      {
        _tag: "SubAgent",
        turn: turnId,
        activity: {
          kind: "started",
          threadId: "t2",
          path: "/a",
          model: "gpt",
          effort: "high",
          startedAtMs: 5,
        },
      },
    ]);
    expect(eventsOf(itemCompleted({ ...base, kind: "completed" }))).toMatchObject([
      { activity: { kind: "completed", model: null, effort: null, startedAtMs: null } },
    ]);
  });

  it.each(["reasoning", "plan", "userMessage", "mcpToolCall", "futureType"])(
    "records a completed %s as an other item",
    (type) => {
      expect(eventsOf(itemCompleted({ type, id: "ignored" }))).toEqual([
        { _tag: "ItemCompleted", turn: turnId, item: { kind: "other", id: "ignored", type } },
      ]);
    },
  );

  it("records a completed tool call as an other item", () => {
    const tool = {
      type: "dynamicToolCall",
      id: "call",
      tool: "ask_orchestrator",
      status: "completed",
    };
    expect(eventsOf(itemCompleted(tool))).toMatchObject([
      { item: { kind: "other", type: "dynamicToolCall" } },
    ]);
  });

  it("reports an undecodable completed item as invalid and keeps the items", () => {
    const items = { items: [message("kept", null)] };
    const decoded = decode(itemCompleted({ type: "commandExecution", id: "cmd" }), items);
    expect(decoded.inbound.events).toEqual([
      { _tag: "DecodeIssue", turn: turnId, method: "item/completed", issue: "invalid" },
    ]);
    expect(decoded.items).toBe(items);
  });
});

describe("Codex hook, usage, error and MCP notifications", () => {
  const hook = Schema.decodeUnknownSync(Codex.HookNotification)(first("hook/started").params);

  it("reports whether a started hook is a project hook", () => {
    expect(eventsOf(first("hook/started"))).toEqual([
      { _tag: "HookStarted", turn: hook.turnId, project: hook.run.source === "project" },
    ]);
    const user = { ...hook, turnId: null, run: { ...hook.run, source: "user" } };
    expect(eventsOf({ method: "hook/started", params: user })).toEqual([
      { _tag: "HookStarted", turn: null, project: false },
    ]);
  });

  it("maps recorded blocked hooks, joining all feedback entries", () => {
    const blocked = recorded("hook/completed")
      .map((raw) => Schema.decodeUnknownSync(Codex.HookNotification)(raw.params))
      .find((params) => params.run.status === "blocked");
    if (blocked === undefined) throw new Error("fixture has no blocked hook");
    const entries = [...blocked.run.entries, { kind: "feedback", text: "Second" }];
    const params = { ...blocked, run: { ...blocked.run, entries } };
    expect(eventsOf({ method: "hook/completed", params })).toEqual([
      {
        _tag: "HookBlocked",
        turn: blocked.turnId,
        event: blocked.run.eventName,
        feedback: entries.map((entry) => entry.text).join("\n"),
      },
    ]);
    const passed = { ...hook, run: { ...hook.run, status: "completed" } };
    expect(eventsOf({ method: "hook/completed", params: passed })).toEqual([]);
  });

  it("reports an undecodable hook as invalid", () => {
    expect(eventsOf({ method: "hook/started", params: { threadId, turnId } })).toEqual([
      { _tag: "DecodeIssue", turn: turnId, method: "hook/started", issue: "invalid" },
    ]);
  });

  it("maps cumulative token totals from the recorded usage notification", () => {
    const raw = first("thread/tokenUsage/updated");
    const params = Schema.decodeUnknownSync(Codex.TokenUsageNotification)(raw.params);
    const total = params.tokenUsage.total;
    expect(eventsOf(raw)).toEqual([
      {
        _tag: "TokenUsage",
        turn: params.turnId,
        totals: {
          input: total.inputTokens,
          cachedInput: total.cachedInputTokens,
          output: total.outputTokens,
          reasoningOutput: total.reasoningOutputTokens,
        },
      },
    ]);
  });

  it("maps retrying errors, while leaving terminal errors to turn completion", () => {
    const error = { message: "reconnecting", codexErrorInfo: "httpConnectionFailed" };
    const params = { threadId, turnId, error, willRetry: true };
    expect(eventsOf({ method: "error", params })).toEqual([
      { _tag: "Retrying", turn: turnId, message: "reconnecting" },
    ]);
    expect(eventsOf({ method: "error", params: { ...params, willRetry: false } })).toEqual([]);
  });

  it("records only failed MCP startups", () => {
    for (const raw of recorded("mcpServer/startupStatus/updated")) {
      const params = Schema.decodeUnknownSync(Codex.McpStartupNotification)(raw.params);
      const expected =
        params.status === "failed"
          ? [{ _tag: "McpStartupFailed", turn: null, server: params.name, error: params.error }]
          : [];
      expect(eventsOf(raw)).toEqual(expected);
    }
  });
});

describe("turn hand-off selection", () => {
  it("prefers final_answer to a later commentary message", () => {
    expect(pickHandoff([message("handoff", "final_answer"), message("later", "commentary")])).toBe(
      "handoff",
    );
  });
  it("falls back to the last agentMessage", () => {
    expect(
      pickHandoff([
        message("first", null),
        message("last", "commentary"),
        { type: "reasoning", id: "r" },
      ]),
    ).toBe("last");
  });
  it("returns none when there is no agent message", () => {
    expect(pickHandoff([])).toBeNull();
    expect(pickHandoff([{ type: "reasoning", id: "r" }])).toBeNull();
  });
});
