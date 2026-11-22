// `foreman mcp-question`, the stdio MCP server agy launches per session, driven through the real
// CLI parser with a scripted stdin the test writes to as it goes and a fake daemon socket that
// records every request.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Cause, Effect, Queue, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli";
import { askOrchestratorTool } from "../src/schemas/codex";
import { ndjson, runCli, tempDir } from "./helpers/cli";

type DaemonBody = { readonly _tag: string } & Record<string, unknown>;
type DaemonReply = { result: unknown } | { error: { tag: string; detail?: string } };
/** A daemon reply, or "hold" to keep the request open until the client closes the socket. */
type DaemonAnswer = DaemonReply | "hold";

const UNAVAILABLE =
  "The foreman orchestrator is unavailable. Continue without the answer, list the question under Open in your hand-off, and take no irreversible step that depends on it.";
const INVALID_ARGUMENTS =
  'ask_orchestrator needs {question: string, kind?: "question" | "blocked"}.';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * A daemon socket at `<home>/foreman.sock` that answers Ping with `build` and every other
 * request with `answer(body)`. It records each request body in order, and each held request's
 * socket closing.
 */
async function fakeDaemon(
  home: string,
  answer: (body: DaemonBody) => DaemonAnswer,
  build = "test",
) {
  const requests: DaemonBody[] = [];
  const closedHolds: DaemonBody[] = [];
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const request = JSON.parse(line) as { id: number; body: DaemonBody };
      requests.push(request.body);
      const reply: DaemonAnswer =
        request.body._tag === "Ping"
          ? { result: { _tag: "Pong", version: "dev", pid: process.pid, build } }
          : answer(request.body);
      if (reply === "hold") socket.on("close", () => closedHolds.push(request.body));
      else socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(join(home, "foreman.sock"), resolve));
  return { requests, closedHolds };
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
const toolResult = (text: string, isError = false, id = 2) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
});

/** Starts `foreman mcp-question --run unit` with a stdin the test feeds line by line. */
function startBridge(home: string) {
  const logFile = join(home, "cli.jsonl");
  const stdin = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done>());
  const program = Command.runWith(cli("test-cli"), { version: "dev", renderErrors: false })([
    "mcp-question",
    "--run",
    "unit",
  ]).pipe(Effect.provide(Stdio.layerTest({ stdin: Stream.fromQueue(stdin) })));
  let stdout = "";
  const exited = runCli(["mcp-question", "--run", "unit"], {
    home,
    env: { FOREMAN_HOME: home, TEST_CLI_LOG_FILE: logFile },
    program,
    stdout: async (text) => {
      stdout += text;
    },
  });
  const responses = () => ndjson(stdout);
  return {
    send: (...lines: string[]) => {
      for (const line of lines) Queue.offerUnsafe(stdin, new TextEncoder().encode(`${line}\n`));
    },
    /** Closes stdin and resolves with the exit status once the bridge has exited. */
    close: async () => {
      Queue.endUnsafe(stdin);
      return (await exited).status;
    },
    responses,
    /** Waits until `count` responses have been written, and returns them. */
    untilResponses: (count: number) =>
      vi.waitFor(() => {
        expect(responses().length).toBeGreaterThanOrEqual(count);
        return responses();
      }),
    log: async () => ndjson(await readFile(logFile, "utf8").catch(() => "")),
  };
}

/** Feeds `lines`, closes stdin, and returns the exit status and every response. */
async function bridge(home: string, lines: readonly string[]) {
  const session = startBridge(home);
  session.send(...lines);
  const status = await session.close();
  return { status, responses: session.responses(), log: await session.log() };
}

/** Sends one call, waits for its reply, then closes stdin. */
async function askOnce(home: string, args: unknown) {
  const session = startBridge(home);
  session.send(ask(args));
  const responses = await session.untilResponses(1);
  return { responses, status: await session.close(), log: await session.log() };
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
    const daemon = await fakeDaemon(home, () => ({
      result: { _tag: "AskAnswer", text: "Use B." },
    }));
    const result = await askOnce(home, {
      question: "A or B?",
      kind: "blocked",
      toolSummary: "asking",
    });
    expect(result.status).toBe(0);
    expect(result.responses).toEqual([toolResult("Use B.")]);
    expect(daemon.requests).toEqual([
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
    const daemon = await fakeDaemon(home, () => ({ result: { _tag: "AskAnswer", text: "ok" } }));
    await askOnce(home, { question: "Which?" });
    expect(daemon.requests[1]).toMatchObject({ _tag: "Ask", question: "Which?", kind: "question" });
  });

  it("returns the run's refusal as a tool error", async () => {
    const home = await tempDir();
    await fakeDaemon(home, () => ({
      error: { tag: "RunConflict", detail: "turn is no longer active" },
    }));
    const result = await askOnce(home, { question: "A or B?" });
    expect(result.responses).toEqual([toolResult("turn is no longer active", true)]);
  });

  it.each([
    { tag: "Defect", detail: undefined },
    { tag: "RunNotFound", detail: "No run named unit." },
  ])("treats a daemon $tag as the orchestrator being unavailable", async (error) => {
    const home = await tempDir();
    await fakeDaemon(home, () => ({ error }));
    const result = await askOnce(home, { question: "A or B?" });
    expect(result.responses).toEqual([toolResult(UNAVAILABLE, true)]);
  });

  it("tells the model the orchestrator is unavailable when no daemon listens", async () => {
    const home = await tempDir();
    const result = await askOnce(home, { question: "A or B?" });
    expect(result.status).toBe(0);
    expect(result.responses).toEqual([toolResult(UNAVAILABLE, true)]);
    expect(result.log).toContainEqual(
      expect.objectContaining({ msg: "mcp-question.daemon-unavailable", level: "warn" }),
    );
  });

  it("asks a daemon of another build without stopping or replacing it", async () => {
    const home = await tempDir();
    const daemon = await fakeDaemon(
      home,
      () => ({ result: { _tag: "AskAnswer", text: "Use A." } }),
      "older-build",
    );
    const result = await askOnce(home, { question: "A or B?" });
    expect(result.responses).toEqual([toolResult("Use A.")]);
    expect(daemon.requests.map((body) => body._tag)).toEqual(["Ping", "Ask"]);
  });

  it("answers unknown methods with -32601, bad tool calls with -32602 and bad arguments with a tool error", async () => {
    const home = await tempDir();
    const result = await bridge(home, [
      message(5, "resources/list"),
      message(6, "tools/call", { name: "other_tool", arguments: {} }),
      message(7, "tools/call", { arguments: {} }),
      message(8, "tools/call", { name: "ask_orchestrator", arguments: { kind: "question" } }),
    ]);
    expect(result.responses).toEqual([
      {
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32601, message: "Method not found: resources/list" },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        error: { code: -32602, message: expect.stringContaining("other_tool") },
      },
      { jsonrpc: "2.0", id: 7, error: { code: -32602, message: expect.any(String) } },
      toolResult(INVALID_ARGUMENTS, true, 8),
    ]);
  });

  it("logs a malformed line to the log file at once and keeps serving", async () => {
    const home = await tempDir();
    const session = startBridge(home);
    session.send("{not json");
    await vi.waitFor(async () =>
      expect(await session.log()).toContainEqual(
        expect.objectContaining({ msg: "mcp-question.malformed-line", level: "warn" }),
      ),
    );
    session.send(initialize);
    expect(await session.untilResponses(1)).toEqual([expect.objectContaining({ id: 1 })]);
    expect(await session.close()).toBe(0);
  });

  it("closes a held question's socket when stdin closes, without replying", async () => {
    const home = await tempDir();
    const daemon = await fakeDaemon(home, () => "hold");
    const session = startBridge(home);
    session.send(ask({ question: "A or B?" }));
    await vi.waitFor(() => expect(daemon.requests).toHaveLength(2));
    expect(await session.close()).toBe(0);
    await vi.waitFor(() => expect(daemon.closedHolds).toHaveLength(1));
    expect(session.responses()).toEqual([]);
  });

  it("closes a held question's socket on notifications/cancelled and keeps serving", async () => {
    const home = await tempDir();
    const daemon = await fakeDaemon(home, () => "hold");
    const session = startBridge(home);
    session.send(ask({ question: "A or B?" }));
    await vi.waitFor(() => expect(daemon.requests).toHaveLength(2));
    session.send(message(null, "notifications/cancelled", { requestId: 2, reason: "timeout" }));
    await vi.waitFor(() => expect(daemon.closedHolds).toHaveLength(1));
    session.send(message(3, "ping"));
    expect(await session.untilResponses(1)).toEqual([{ jsonrpc: "2.0", id: 3, result: {} }]);
    expect(await session.close()).toBe(0);
  });
});
