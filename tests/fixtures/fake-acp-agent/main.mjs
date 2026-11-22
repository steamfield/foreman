#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { AcpScenario } from "./scenario.ts";

const scenario = Schema.decodeUnknownSync(Schema.fromJsonString(AcpScenario))(
  readFileSync(process.env.FAKE_ACP_SCENARIO ?? "", "utf8"),
);
if (process.argv[2] !== "acp") throw new Error("expected acp as the first argument");
if (process.env.FAKE_ACP_ARGS) appendFileSync(process.env.FAKE_ACP_ARGS, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env })}\n`);
const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const Params = Schema.Record(Schema.String, Schema.Unknown);
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const used = new Set();
let session = "";
let cwd = "";
let seq = 0;
let requestId = 0;
const labels = new Map();
const responses = new Set();
const waits = new Set();
let mcpServers = [];
const mcpCalls = new Map();
const mcpChildren = new Set();
// session/prompt requests still playing their rule's steps, by request id: {session, rule}.
const outstandingPrompts = new Map();

function killMcpChildren() {
  for (const child of mcpChildren) child.kill("SIGKILL");
}
process.on("exit", killMcpChildren);
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

// One MCP server child per call, speaking JSON-RPC lines on stdio like agy's MCP client.
function startMcpCall({ tool, arguments: args, label }) {
  const server = mcpServers.find((entry) => typeof entry?.command === "string");
  if (server === undefined) throw new Error(`mcpCall ${label}: no stdio server in mcpServers`);
  const env = { ...process.env };
  for (const { name, value } of server.env ?? []) env[name] = value;
  const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
  mcpChildren.add(child);
  const exited = new Promise((resolve) => {
    child.on("error", (error) => resolve({ exited: { code: null, signal: null, error: error.message } }));
    child.on("exit", (code, signal) => resolve({ exited: { code, signal } }));
  }).finally(() => mcpChildren.delete(child));
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  child.stdin.on("error", () => {});
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params) => Promise.race([
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
    }),
    exited,
  ]);
  const outcome = (async () => {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1.5.14" } });
    if ("exited" in initialized || initialized.error !== undefined) return initialized;
    send({ method: "notifications/initialized" });
    return request("tools/call", { name: tool, arguments: substitute(args) });
  })().then((ended) => {
    child.stdin.end();
    const line = "exited" in ended ? { label, exited: ended.exited } : { label, response: ended };
    if (process.env.FAKE_ACP_MCP_LOG) appendFileSync(process.env.FAKE_ACP_MCP_LOG, `${JSON.stringify(line)}\n`);
  });
  mcpCalls.set(label, { child, outcome });
}
function mcpCall(label) {
  const call = mcpCalls.get(label);
  if (call === undefined) throw new Error(`unknown MCP call label: ${label}`);
  return call;
}

function substitute(value) {
  if (typeof value === "string") return value.replace(/\{\{(session|seq|cwd)\}\}/g, (_, name) => {
    if (name === "session") return session;
    if (name === "cwd") return cwd;
    return String(++seq);
  });
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child)]));
  return value;
}
function subset(expected, actual) {
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => subset(value, Reflect.get(actual, key)));
}
function waitFor(accepts, timeoutMs) {
  return new Promise((resolve) => {
    const wait = { accepts, resolve: () => { clearTimeout(timer); waits.delete(wait); resolve(); } };
    const timer = timeoutMs === undefined ? undefined : setTimeout(wait.resolve, timeoutMs);
    waits.add(wait);
  });
}
async function steps(script) {
  for (const step of script) {
    if ("notify" in step) write({ method: step.notify, params: substitute(step.params) });
    else if ("request" in step) {
      const id = `r${requestId++}`;
      labels.set(step.label, id);
      write({ id, method: step.request, params: substitute(step.params) });
    } else if ("awaitResponse" in step) {
      const id = labels.get(step.awaitResponse);
      if (id === undefined) throw new Error(`unknown request label: ${step.awaitResponse}`);
      if (!responses.has(id)) await waitFor((message) => !message.method && message.id === id, step.timeoutMs);
    } else if ("awaitRequest" in step) await waitFor((message) => message.method === step.awaitRequest, step.timeoutMs);
    else if ("sleepMs" in step) await delay(step.sleepMs);
    else if ("stderr" in step) process.stderr.write(`${step.stderr}\n`);
    else if ("writeFile" in step) writeFileSync(substitute(step.writeFile), step.text);
    else if ("gate" in step) {
      writeFileSync(step.gate.ready, "ready");
      // Async, so the fake keeps reading foreman and its MCP children while the gate is shut.
      await readFile(step.gate.release);
    }
    else if ("exit" in step) process.exit(step.exit);
    else if ("mcpCall" in step) startMcpCall(step.mcpCall);
    else if ("awaitMcpResult" in step) {
      const { outcome } = mcpCall(step.awaitMcpResult.label);
      const timeoutMs = step.awaitMcpResult.timeoutMs;
      await (timeoutMs === undefined ? outcome : Promise.race([outcome, delay(timeoutMs)]));
    } else if ("killMcp" in step) mcpCall(step.killMcp).child.kill("SIGKILL");
  }
}
function remember(method, params) {
  const fields = Schema.decodeUnknownSync(Params)(params ?? {});
  if (method === "session/new") {
    session = randomUUID();
    cwd = typeof fields.cwd === "string" ? fields.cwd : "";
  }
  if ((method === "session/new" || method === "session/load" || method === "session/resume") && Array.isArray(fields.mcpServers)) mcpServers = fields.mcpServers;
  if ((method === "session/load" || method === "session/resume") && typeof fields.sessionId === "string") session = fields.sessionId;
}
function defaultResult(method) {
  if (method === "session/new" || method === "session/load" || method === "session/resume") return { sessionId: session, modes: { currentModeId: "default", availableModes: [] } };
  if (method === "session/set_config_option" || method === "session/set_mode" || method === "session/set_model") return {};
  return undefined;
}
// agy merges a prompt sent mid-turn into the turn: the earlier prompt replies end_turn at once,
// and the later prompt's reply ends the real turn. The earlier rule's steps play on.
function mergePrompts(session) {
  for (const [id, prompt] of outstandingPrompts) {
    if (prompt.session !== session) continue;
    outstandingPrompts.delete(id);
    const respond = prompt.rule.respond;
    const result = typeof respond === "object" && "result" in respond ? substitute(respond.result) : {};
    write({ id, result: { ...result, stopReason: "end_turn" } });
  }
}
async function reply(message, rule) {
  if (rule.respond === "none") return;
  if (rule.delayMs !== undefined) await delay(rule.delayMs);
  if ("error" in rule.respond) write({ id: message.id, error: substitute(rule.respond.error) });
  else write({ id: message.id, result: substitute(rule.respond.result) });
}

async function receive(line) {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${line}\n`);
  const message = Schema.decodeUnknownSync(Schema.fromJsonString(Message))(line);
  if (!message.method && message.id !== undefined) responses.add(message.id);
  for (const wait of waits) if (wait.accepts(message)) wait.resolve();
  if (message.method === "initialize") {
    write({ id: message.id, result: { protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL ?? 1), agentCapabilities: { loadSession: true }, agentInfo: { name: "Fake ACP Agent", version: process.env.FAKE_ACP_VERSION ?? "1.5.14" }, authMethods: [] } });
    return;
  }
  if (!message.method || message.id === undefined) return;
  const promptSession = message.method === "session/prompt" ? Schema.decodeUnknownSync(Params)(message.params ?? {}).sessionId : undefined;
  if (promptSession !== undefined) mergePrompts(promptSession);
  remember(message.method, message.params);
  const index = scenario.rules.findIndex((rule, index) => (!used.has(index) || rule.repeat) && rule.method === message.method && (!rule.when || subset(rule.when, message.params)));
  const rule = scenario.rules[index];
  if (!rule) {
    const result = defaultResult(message.method);
    if (result === undefined) write({ id: message.id, error: { code: -32601, message: `no rule for ${message.method}` } });
    else write({ id: message.id, result });
    return;
  }
  used.add(index);
  if (rule.respondAfterSteps) {
    if (promptSession !== undefined) outstandingPrompts.set(message.id, { session: promptSession, rule });
    await steps(rule.steps ?? []);
    // A later prompt merged this one and already replied for it.
    if (promptSession !== undefined && !outstandingPrompts.delete(message.id)) return;
    await reply(message, rule);
    return;
  }
  await reply(message, rule);
  await steps(rule.steps ?? []);
}

const input = createInterface({ input: process.stdin });
// agy's MCP servers end with it; without this, their pipes would keep the fake alive.
input.on("close", killMcpChildren);
input.on("line", (line) => {
  receive(line).catch((error) => { console.error(error); process.exit(1); });
});
