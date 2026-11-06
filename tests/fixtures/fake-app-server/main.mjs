#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { Scenario } from "./scenario.ts";

const scenario = Schema.decodeUnknownSync(Schema.fromJsonString(Scenario))(
  readFileSync(process.env.FAKE_APP_SERVER_SCENARIO ?? "", "utf8"),
);
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") {
  throw new Error("expected app-server --listen stdio://");
}
const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const used = new Set();
let thread = "";
let turn = "";
let seq = 0;
let requestId = 0;
const labels = new Map();
const responses = new Set();
const waits = new Set();

function substitute(value) {
  if (typeof value === "string") return value.replace(/\{\{(thread|turn|seq)\}\}/g, (_, name) => {
    if (name === "thread") return thread;
    if (name === "turn") return turn;
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
      const id = requestId++;
      labels.set(step.label, id);
      write({ id, method: step.request, params: substitute(step.params) });
    } else if ("awaitResponse" in step) {
      const id = labels.get(step.awaitResponse);
      if (id === undefined) throw new Error(`unknown request label: ${step.awaitResponse}`);
      if (!responses.has(id)) await waitFor((message) => !message.method && message.id === id, step.timeoutMs);
    } else if ("awaitRequest" in step) await waitFor((message) => message.method === step.awaitRequest, step.timeoutMs);
    else if ("sleepMs" in step) await delay(step.sleepMs);
    else if ("stderr" in step) process.stderr.write(`${step.stderr}\n`);
    else if ("exit" in step) process.exit(step.exit);
  }
}

function responseResult(method, value) {
  if (!["thread/start", "thread/resume", "turn/start"].includes(method)) return substitute(value);
  const result = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value);
  if (method === "thread/start" || method === "thread/resume") {
    const part = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.optionalKey(Schema.String) }))(result.thread ?? {});
    thread = part.id === undefined ? randomUUID() : substitute(part.id);
    return substitute({ ...result, thread: { ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(result.thread ?? {}), id: thread } });
  }
  if (method === "turn/start") {
    const part = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.optionalKey(Schema.String) }))(result.turn ?? {});
    turn = part.id === undefined ? randomUUID() : substitute(part.id);
    return substitute({ ...result, turn: { ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(result.turn ?? {}), id: turn } });
  }
  return value;
}

async function receive(line) {
  if (process.env.FAKE_APP_SERVER_LOG) appendFileSync(process.env.FAKE_APP_SERVER_LOG, `${line}\n`);
  const message = Schema.decodeUnknownSync(Schema.fromJsonString(Message))(line);
  if (!message.method && message.id !== undefined) responses.add(message.id);
  for (const wait of waits) if (wait.accepts(message)) wait.resolve();
  if (message.method === "initialize") { write({ id: message.id, result: {} }); return; }
  if (message.method === "initialized") { await steps(scenario.onStart ?? []); return; }
  if (!message.method || message.id === undefined) return;
  const index = scenario.rules.findIndex((rule, index) => (!used.has(index) || rule.repeat) && rule.method === message.method && (!rule.when || subset(rule.when, message.params)));
  const rule = scenario.rules[index];
  if (!rule) { write({ id: message.id, error: { code: -32601, message: `no rule for ${message.method}` } }); return; }
  used.add(index);
  if (rule.gate) {
    writeFileSync(rule.gate.ready, "ready");
    readFileSync(rule.gate.release);
  }
  if (rule.respond !== "none") {
    if (rule.delayMs !== undefined) await delay(rule.delayMs);
    if ("error" in rule.respond) write({ id: message.id, error: substitute(rule.respond.error) });
    else write({ id: message.id, result: responseResult(message.method, rule.respond.result) });
  }
  await steps(rule.steps ?? []);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  receive(line).catch((error) => { console.error(error); process.exit(1); });
});
