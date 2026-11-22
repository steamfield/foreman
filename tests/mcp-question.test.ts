// `foreman mcp-question`, the stdio MCP server agy launches per session, driven through the real
// CLI parser with scripted stdin and a fake daemon socket that records every request.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { afterEach, describe, expect, it } from "vitest";
import { cli } from "../src/cli";
import { askOrchestratorTool } from "../src/schemas/codex";
import { ndjson, runCli, tempDir } from "./helpers/cli";

type DaemonBody = { readonly _tag: string } & Record<string, unknown>;
type DaemonReply = { result: unknown } | { error: { tag: string; detail?: string } };

const UNAVAILABLE =
  "The foreman orchestrator is unavailable. Continue without the answer, list the question under Open in your hand-off, and take no irreversible step that depends on it.";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * A daemon socket at `<home>/foreman.sock` that answers Ping with `build` and every other
 * request with `answer(body)`, recording each request body in order.
 */
async function fakeDaemon(home: string, answer: (body: DaemonBody) => DaemonReply, build = "test") {
  const requests: DaemonBody[] = [];
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line) as { id: number; body: DaemonBody };
      requests.push(request.body);
      const reply: DaemonReply =
        request.body._tag === "Ping"
          ? { result: { _tag: "Pong", version: "dev", pid: process.pid, build } }
          : answer(request.body);
      socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(join(home, "foreman.sock"), resolve));
  return requests;
}

const message = (id: number | null, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params });
const initialize = message(1, "initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "agy", version: "1.5.14" },
});
const initialized = message(null, "notifications/initialized");
const ask = (args: unknown) =>
  message(2, "tools/call", { name: "ask_orchestrator", arguments: args });
const toolResult = (text: string, isError = false) => ({
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
});

/** Runs `foreman mcp-question --run unit` with `lines` on stdin, then stdin closed. */
async function bridge(home: string, lines: readonly string[]) {
  const logFile = join(home, "cli.jsonl");
  const stdin = Stream.make(new TextEncoder().encode(lines.map((line) => `${line}\n`).join("")));
  const program = Command.runWith(cli("test-cli"), { version: "dev", renderErrors: false })([
    "mcp-question",
    "--run",
    "unit",
  ]).pipe(Effect.provide(Stdio.layerTest({ stdin })));
  const run = await runCli(["mcp-question", "--run", "unit"], {
    home,
    env: { FOREMAN_HOME: home, TEST_CLI_LOG_FILE: logFile },
    program,
  });
  const log = await readFile(logFile, "utf8").catch(() => "");
  return { ...run, responses: ndjson(run.stdout), log: ndjson(log) };
}

describe("foreman mcp-question", () => {
  it("initializes with the client's protocol version and lists Codex's ask_orchestrator", async () => {
    const home = await tempDir();
    const result = await bridge(home, [initialize, initialized, message(3, "tools/list")]);
    expect(result.status).toBe(0);
    expect(result.responses).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "foreman", version: "dev" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          tools: [
            {
              name: "ask_orchestrator",
              description: askOrchestratorTool.description,
              inputSchema: askOrchestratorTool.inputSchema,
            },
          ],
        },
      },
    ]);
  });

  it("forwards a call as Ask, ignores toolSummary, and returns the answer as the tool result", async () => {
    const home = await tempDir();
    const requests = await fakeDaemon(home, () => ({
      result: { _tag: "AskAnswer", text: "Use B." },
    }));
    const result = await bridge(home, [
      initialize,
      initialized,
      ask({ question: "A or B?", kind: "blocked", toolSummary: "asking" }),
    ]);
    expect(result.status).toBe(0);
    expect(result.responses.slice(1)).toEqual([toolResult("Use B.")]);
    expect(requests).toEqual([
      { _tag: "Ping" },
      {
        _tag: "Ask",
        name: "unit",
        question: "A or B?",
        kind: "blocked",
        callId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
  });

  it("asks with kind question when the call names no kind", async () => {
    const home = await tempDir();
    const requests = await fakeDaemon(home, () => ({ result: { _tag: "AskAnswer", text: "ok" } }));
    await bridge(home, [ask({ question: "Which?" })]);
    expect(requests[1]).toMatchObject({ _tag: "Ask", question: "Which?", kind: "question" });
  });

  it("returns the run's refusal as a tool error", async () => {
    const home = await tempDir();
    await fakeDaemon(home, () => ({
      error: { tag: "RunConflict", detail: "turn is no longer active" },
    }));
    const result = await bridge(home, [ask({ question: "A or B?" })]);
    expect(result.responses).toEqual([toolResult("turn is no longer active", true)]);
  });

  it("tells the model the orchestrator is unavailable when no daemon listens", async () => {
    const home = await tempDir();
    const result = await bridge(home, [ask({ question: "A or B?" })]);
    expect(result.status).toBe(0);
    expect(result.responses).toEqual([toolResult(UNAVAILABLE, true)]);
    expect(result.log).toContainEqual(
      expect.objectContaining({ msg: "mcp-question.daemon-unavailable", level: "warn" }),
    );
  });

  it("asks a daemon of another build without stopping or replacing it", async () => {
    const home = await tempDir();
    const requests = await fakeDaemon(
      home,
      () => ({ result: { _tag: "AskAnswer", text: "Use A." } }),
      "older-build",
    );
    const result = await bridge(home, [ask({ question: "A or B?" })]);
    expect(result.responses).toEqual([toolResult("Use A.")]);
    expect(requests.map((body) => body._tag)).toEqual(["Ping", "Ask"]);
  });

  it("answers unknown methods with -32601 and bad tool calls with -32602", async () => {
    const home = await tempDir();
    const result = await bridge(home, [
      message(5, "resources/list"),
      message(6, "tools/call", { name: "other_tool", arguments: {} }),
      message(7, "tools/call", { name: "ask_orchestrator", arguments: { kind: "question" } }),
    ]);
    const errors = result.responses.map((response) => (response as { error: unknown }).error);
    expect(result.responses.map((response) => (response as { id: number }).id).sort()).toEqual([
      5, 6, 7,
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        { code: -32601, message: "Method not found: resources/list" },
        expect.objectContaining({ code: -32602, message: expect.stringContaining("other_tool") }),
        expect.objectContaining({ code: -32602, message: expect.stringContaining("question") }),
      ]),
    );
  });

  it("skips a malformed line with a log record and keeps serving", async () => {
    const home = await tempDir();
    const result = await bridge(home, ["{not json", initialize]);
    expect(result.status).toBe(0);
    expect(result.responses).toEqual([expect.objectContaining({ id: 1 })]);
    expect(result.log).toContainEqual(
      expect.objectContaining({ msg: "mcp-question.malformed-line", level: "warn" }),
    );
  });
});
