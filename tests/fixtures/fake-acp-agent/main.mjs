#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
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
      readFileSync(step.gate.release);
    }
    else if ("exit" in step) process.exit(step.exit);
  }
}
function remember(method, params) {
  const fields = Schema.decodeUnknownSync(Params)(params ?? {});
  if (method === "session/new") {
    session = randomUUID();
    cwd = typeof fields.cwd === "string" ? fields.cwd : "";
  }
  if ((method === "session/load" || method === "session/resume") && typeof fields.sessionId === "string") session = fields.sessionId;
}
function defaultResult(method) {
  if (method === "session/new" || method === "session/load" || method === "session/resume") return { sessionId: session, modes: { currentModeId: "default", availableModes: [] } };
  if (method === "session/set_config_option" || method === "session/set_mode" || method === "session/set_model") return {};
  return undefined;
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
    await steps(rule.steps ?? []);
    await reply(message, rule);
    return;
  }
  await reply(message, rule);
  await steps(rule.steps ?? []);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  receive(line).catch((error) => { console.error(error); process.exit(1); });
});
