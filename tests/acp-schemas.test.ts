// The ACP schemas against agy 1.5.14's recorded wire (tests/fixtures/agy-1.5.14.jsonl): every
// message foreman reads decodes, and every recorded session update maps without a decode issue.
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readNotification } from "../src/providers/agy/events";
import { beginTurn, openedSession } from "../src/providers/agy/turns";
import * as Acp from "../src/schemas/acp";

const lines: unknown[] = readFileSync(
  new URL("./fixtures/agy-1.5.14.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const Response = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  result: Schema.Unknown,
});
const Notification = Schema.Struct({ method: Schema.String, params: Schema.Unknown });
const Request = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  method: Schema.String,
  params: Schema.Unknown,
});

const responses = lines.filter(Schema.is(Response));
const fromAgy = (method: string) =>
  lines.filter(Schema.is(Notification)).filter((line) => line.method === method);
const updates = fromAgy(Acp.Method.update).filter((line) => !Schema.is(Request)(line));
const decode = <A, I>(schema: Schema.Codec<A, I>) => Schema.decodeUnknownSync(schema);

describe("agy 1.5.14 replies", () => {
  it("decodes the initialize reply's protocol and version", () => {
    const [initialize] = responses;
    expect(decode(Acp.InitializeResult)(initialize?.result)).toEqual({
      protocolVersion: 1,
      agentInfo: { version: "1.5.14" },
    });
  });

  it("decodes every prompt reply's stop reason and usage", () => {
    const prompts = responses.slice(1).map((response) => decode(Acp.PromptResult)(response.result));
    expect(prompts).toEqual([
      {
        stopReason: "end_turn",
        usage: { inputTokens: 16009, outputTokens: 360, cachedReadTokens: 22442, thoughtTokens: 0 },
      },
      {
        stopReason: "cancelled",
        usage: { inputTokens: 2128, outputTokens: 38, cachedReadTokens: 7590, thoughtTokens: 0 },
      },
    ]);
  });
});

describe("agy 1.5.14 requests", () => {
  it("decodes the permission request with its tool call and options", () => {
    const [permission] = fromAgy(Acp.Method.requestPermission);
    expect(decode(Acp.PermissionRequest)(permission?.params)).toMatchObject({
      sessionId: "d4097300-588b-447d-a2bc-4248c630b775",
      toolCall: { toolCallId: "call_11419618722465926217", name: "write_file", kind: "edit" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    });
  });
});

describe("agy 1.5.14 session updates", () => {
  const activeSession = () => ({
    turn: beginTurn(openedSession("write"), {
      turn: 1,
      kind: "start",
      input: "go",
      settings: { cwd: "/tmp", model: "m", effort: "low", tier: null, access: "write" },
    }),
    tools: new Map(),
  });

  it.each(updates.map((line, index) => [index, line] as const))(
    "maps recorded update %i without a decode issue",
    (_index, line) => {
      const sessionId = decode(Acp.SessionUpdate)(line.params).sessionId;
      const { inbound } = readNotification(line, activeSession());
      expect(inbound.session).toBe(sessionId);
      expect(inbound.events.length).toBeGreaterThan(0);
      expect(inbound.events.filter((event) => event._tag === "DecodeIssue")).toEqual([]);
      expect(inbound.events.filter((event) => event._tag === "Unrecognized")).toEqual([]);
    },
  );

  it("reads a completed shell command's exit code and output", () => {
    const completed = updates
      .map((line) => (Schema.is(Acp.SessionUpdate)(line.params) ? line.params.update : null))
      .filter(Schema.is(Acp.ToolCall))
      .find((call) => call.kind === "execute" && call.status === "completed");
    expect(completed?.rawOutput).toEqual({
      output: expect.stringContaining("Command exit"),
      exit_code: 0,
    });
  });

  it("refuses a tool call update without its id", () => {
    expect(Schema.is(Acp.ToolCall)({ sessionUpdate: "tool_call", kind: "execute" })).toBe(false);
  });
});
