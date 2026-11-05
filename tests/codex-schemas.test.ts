// forman's Codex schemas against real app-server traffic: tests/fixtures/codex-0.166.0.jsonl
// holds one recorded message of each shape forman reads, from Codex 0.166.0, with local paths
// replaced. A Codex upgrade that changes a shape fails here first.
import { readFileSync } from "node:fs";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Codex from "../src/schemas/codex";
import { DaemonRequest, DaemonResponse, RunName } from "../src/schemas/daemon";

const lines = readFileSync(new URL("./fixtures/codex-0.166.0.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { method?: string; params?: unknown; result?: unknown });

const paramsSchema: Record<string, Schema.ConstraintDecoder<unknown>> = {
  [Codex.Method.turnStarted]: Codex.TurnNotification,
  [Codex.Method.turnCompleted]: Codex.TurnNotification,
  [Codex.Method.itemStarted]: Codex.ItemNotification,
  [Codex.Method.itemCompleted]: Codex.ItemNotification,
  [Codex.Method.tokenUsageUpdated]: Codex.TokenUsageNotification,
  [Codex.Method.hookStarted]: Codex.HookNotification,
  [Codex.Method.hookCompleted]: Codex.HookNotification,
  [Codex.Method.mcpStartupStatus]: Codex.McpStartupNotification,
  [Codex.Method.toolCall]: Codex.ToolCallParams,
};

const decodes = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));

describe("Codex schemas", () => {
  it.each(lines.filter((line) => line.method !== undefined))("decode $method", (line) => {
    const schema = paramsSchema[line.method as string];
    expect(schema, `no schema for ${line.method}`).toBeDefined();
    expect(decodes(schema as Schema.ConstraintDecoder<unknown>, line.params)).toBe(true);
  });

  it("decode the thread, turn and steer responses", () => {
    const results = lines.filter((line) => line.method === undefined).map((line) => line.result);
    const schemas = [Codex.ThreadOpened, Codex.TurnStartResponse, Codex.TurnSteerResponse];
    for (const schema of schemas)
      expect(results.some((result) => decodes(schema, result))).toBe(true);
  });

  it("read an interrupted turn's status and empty items", () => {
    const line = lines.find(
      (candidate) =>
        candidate.method === Codex.Method.turnCompleted &&
        (candidate.params as { turn: { status: string } }).turn.status === "interrupted",
    );
    const turn = Schema.decodeUnknownSync(Codex.TurnNotification)(line?.params).turn;
    expect(turn).toMatchObject({ status: "interrupted", items: [] });
  });

  it("read the ask_orchestrator arguments from a real tool call", () => {
    const call = lines.find((line) => line.method === Codex.Method.toolCall);
    const params = Schema.decodeUnknownSync(Codex.ToolCallParams)(call?.params);
    expect(params.tool).toBe(Codex.askOrchestratorTool.name);
    expect(Schema.decodeUnknownSync(Codex.AskOrchestratorArguments)(params.arguments)).toEqual({
      question: "Which word should I print?",
    });
  });

  it("keep an unknown codexErrorInfo instead of failing the turn", () => {
    const error = { message: "x", codexErrorInfo: { somethingNew: { detail: 1 } } };
    expect(decodes(Codex.TurnError, error)).toBe(true);
    expect(decodes(Codex.TurnError, { ...error, codexErrorInfo: "notInThisVersion" })).toBe(true);
  });

  it("fall back to the minimal turn shape when the full one no longer decodes", () => {
    const params = { threadId: "t", turn: { id: "u", status: "somethingNew", items: "?" } };
    expect(decodes(Codex.TurnNotification, params)).toBe(false);
    expect(decodes(Codex.TurnNotificationMinimal, params)).toBe(true);
  });
});

describe("daemon protocol", () => {
  it("round-trips a request and both response forms", () => {
    const request = {
      id: 1,
      body: { _tag: "Steer", name: "unit-a", message: "Use the existing helper." },
    };
    const decoded = Schema.decodeUnknownSync(DaemonRequest)(request);
    expect(Schema.encodeSync(DaemonRequest)(decoded)).toEqual(request);
    for (const response of [
      { id: 1, result: { _tag: "Ok" } },
      { id: 1, error: { tag: "RunConflict", detail: "unit-a has no turn in progress" } },
    ])
      expect(
        Schema.encodeSync(DaemonResponse)(Schema.decodeUnknownSync(DaemonResponse)(response)),
      ).toEqual(response);
  });

  it.each(["unit-a", "a", "fix.cli_2"])("accepts run name %s", (name) => {
    expect(decodes(RunName, name)).toBe(true);
  });
  it.each(["", "Unit", "-a", "a/b", "a".repeat(65)])("rejects run name %j", (name) => {
    expect(decodes(RunName, name)).toBe(false);
  });
});
