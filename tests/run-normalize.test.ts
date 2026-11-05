import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { normalizeNotification, pickHandoff } from "../src/core/runs/normalize";
import * as Codex from "../src/schemas/codex";

const envelope = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
});
const messages = readFileSync(new URL("./fixtures/codex-0.166.0.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(envelope))(line));

function fixture<S extends Schema.ConstraintDecoder<unknown>>(method: string, schema: S) {
  const message = messages.find((message) => message.method === method);
  return Schema.decodeUnknownSync(schema)(message?.params);
}

const turn = fixture("turn/started", Codex.TurnNotification);
const completed = messages
  .filter((message) => message.method === "item/completed")
  .map((message) => Schema.decodeUnknownSync(Codex.ItemNotification)(message.params));
const item = Schema.decodeUnknownSync(Codex.ItemNotification)(
  completed.find((message) => Schema.is(Codex.CommandExecutionItem)(message.item)),
);
const agent = completed.find((message) => Schema.is(Codex.AgentMessageItem)(message.item));

describe("notification normalization", () => {
  it("drops agent-message deltas without producing an event", () => {
    const notification = Schema.decodeUnknownSync(Codex.RpcNotification)({
      method: "item/agentMessage/delta",
      params: { delta: "still writing" },
    });
    expect(
      normalizeNotification(
        { method: "item/agentMessage/delta", params: notification.params },
        1,
        "start",
      ),
    ).toEqual([]);
  });

  it("maps a recorded turn start with the caller's turn number and kind", () => {
    expect(normalizeNotification({ method: "turn/started", params: turn }, 2, "followup")).toEqual([
      { _tag: "TurnStarted", turn: 2, kind: "followup" },
    ]);
  });

  it("maps recorded completion and interruption, keeping status and failure", () => {
    for (const message of messages.filter((message) => message.method === "turn/completed")) {
      const params = Schema.decodeUnknownSync(Codex.TurnNotification)(message.params);
      expect(normalizeNotification({ method: "turn/completed", params }, 2, "start")).toEqual([
        { _tag: "TurnCompleted", turn: 2, status: params.turn.status, failure: null },
      ]);
    }
    const failure = { message: "capacity", codexErrorInfo: { serverOverloaded: {} } };
    expect(
      normalizeNotification(
        {
          method: "turn/completed",
          params: {
            ...turn,
            turn: { ...turn.turn, status: "failed", error: failure },
          },
        },
        3,
        "handoff",
      ),
    ).toEqual([{ _tag: "TurnCompleted", turn: 3, status: "failed", failure }]);
  });

  it("maps a recorded completed command", () => {
    const command = Schema.decodeUnknownSync(Codex.CommandExecutionItem)(item.item);
    expect(normalizeNotification({ method: "item/completed", params: item }, 1, "start")).toEqual([
      {
        _tag: "Command",
        command: command.command,
        status: "completed",
        exitCode: 0,
        outputTail: command.aggregatedOutput,
      },
    ]);
  });

  it("keeps the last 2 KB of command output on UTF-8 boundaries and handles null", () => {
    const command = Schema.decodeUnknownSync(Codex.CommandExecutionItem)(item.item);
    const mapped = normalizeNotification(
      {
        method: "item/completed",
        params: {
          ...item,
          item: { ...command, aggregatedOutput: `prefix${"é".repeat(1100)}x` },
        },
      },
      1,
      "start",
    );
    expect(mapped).toEqual([
      {
        _tag: "Command",
        command: command.command,
        status: "completed",
        exitCode: 0,
        outputTail: `${"é".repeat(1023)}x`,
      },
    ]);
    expect(
      normalizeNotification(
        {
          method: "item/completed",
          params: {
            ...item,
            item: { ...command, aggregatedOutput: null },
          },
        },
        1,
        "start",
      ),
    ).toMatchObject([{ outputTail: "" }]);
  });

  it("maps file changes using a decoded item notification", () => {
    const params = Schema.decodeUnknownSync(Codex.ItemNotification)({
      ...item,
      item: { type: "fileChange", id: "files", changes: [{ path: "src/a.ts" }, { path: "b.ts" }] },
    });
    expect(normalizeNotification({ method: "item/completed", params }, 1, "start")).toEqual([
      { _tag: "FileChange", paths: ["src/a.ts", "b.ts"] },
    ]);
  });

  it("maps a recorded agent message with phase", () => {
    expect(agent).toBeDefined();
    if (agent === undefined) return;
    const message = Schema.decodeUnknownSync(Codex.AgentMessageItem)(agent.item);
    expect(normalizeNotification({ method: "item/completed", params: agent }, 1, "start")).toEqual([
      { _tag: "AgentMessage", text: message.text, phase: "final_answer" },
    ]);
  });

  it("maps recorded blocked hooks, joining all feedback entries", () => {
    const raw = messages
      .filter((message) => message.method === "hook/completed")
      .map((message) => Schema.decodeUnknownSync(Codex.HookNotification)(message.params))
      .find((message) => message.run.status === "blocked");
    expect(raw).toBeDefined();
    if (raw === undefined) return;
    const params = {
      ...raw,
      run: { ...raw.run, entries: [...raw.run.entries, { kind: "feedback", text: "Second" }] },
    };
    expect(normalizeNotification({ method: "hook/completed", params }, 1, "start")).toEqual([
      {
        _tag: "HookBlocked",
        event: params.run.eventName,
        feedback: params.run.entries.map((entry) => entry.text).join("\n"),
      },
    ]);
  });

  it("maps cumulative token totals from the recorded usage notification", () => {
    const params = fixture("thread/tokenUsage/updated", Codex.TokenUsageNotification);
    const total = params.tokenUsage.total;
    expect(
      normalizeNotification({ method: "thread/tokenUsage/updated", params }, 1, "start"),
    ).toEqual([
      {
        _tag: "TokenUsage",
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
    const params = Schema.decodeUnknownSync(Codex.ErrorNotification)({
      threadId: turn.threadId,
      turnId: turn.turn.id,
      error: { message: "reconnecting", codexErrorInfo: "httpConnectionFailed" },
      willRetry: true,
    });
    expect(normalizeNotification({ method: "error", params }, 1, "start")).toEqual([
      { _tag: "Retrying", message: "reconnecting" },
    ]);
    expect(
      normalizeNotification(
        { method: "error", params: { ...params, willRetry: false } },
        1,
        "start",
      ),
    ).toEqual([]);
  });

  it("records only failed MCP startups", () => {
    for (const message of messages.filter(
      (message) => message.method === "mcpServer/startupStatus/updated",
    )) {
      const params = Schema.decodeUnknownSync(Codex.McpStartupNotification)(message.params);
      const expected =
        params.status === "failed"
          ? [{ _tag: "McpStartupFailed", server: params.name, error: params.error }]
          : [];
      expect(
        normalizeNotification({ method: "mcpServer/startupStatus/updated", params }, 1, "start"),
      ).toEqual(expected);
    }
  });

  it("drops item starts, ordinary hooks, tool calls and reasoning items", () => {
    expect(normalizeNotification({ method: "item/started", params: item }, 1, "start")).toEqual([]);
    const hook = fixture("hook/started", Codex.HookNotification);
    expect(normalizeNotification({ method: "hook/started", params: hook }, 1, "start")).toEqual([]);
    expect(
      normalizeNotification(
        {
          method: "hook/completed",
          params: { ...hook, run: { ...hook.run, status: "completed" } },
        },
        1,
        "start",
      ),
    ).toEqual([]);
    for (const type of ["reasoning", "plan", "userMessage", "mcpToolCall", "futureType"])
      expect(
        normalizeNotification(
          { method: "item/completed", params: { ...item, item: { type, id: "ignored" } } },
          1,
          "start",
        ),
      ).toEqual([]);
    const tool = Schema.decodeUnknownSync(Codex.ItemNotification)({
      ...item,
      item: { type: "dynamicToolCall", id: "call", tool: "ask_orchestrator", status: "completed" },
    });
    expect(normalizeNotification({ method: "item/completed", params: tool }, 1, "start")).toEqual(
      [],
    );
  });
});

describe("turn hand-off selection", () => {
  const message = (text: string, phase: "final_answer" | "commentary" | null) =>
    Schema.decodeUnknownSync(Codex.AgentMessageItem)({
      type: "agentMessage",
      id: text,
      text,
      phase,
    });
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
