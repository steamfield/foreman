import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { Method } from "../../../src/schemas/codex";
import type { Scenario, Step } from "./scenario";

const Recorded = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  result: Schema.optionalKey(Schema.Unknown),
});
const recordings = readFileSync(new URL("../codex-0.166.0.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Recorded))(line));

function recorded(method: string, shape: Schema.ConstraintDecoder<unknown> = Schema.Unknown) {
  const message = recordings.find(
    (line) => line.method === method && Schema.is(shape)(line.params),
  );
  if (!message?.params) throw new Error(`missing recorded ${method}`);
  return message.params;
}
function item(type: string, status?: string) {
  for (const line of recordings) {
    if (line.method !== Method.itemCompleted) continue;
    const candidate = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      line.params?.item,
    );
    if (candidate.type === type && (!status || candidate.status === status)) return candidate;
  }
  throw new Error(`missing recorded item ${type} ${status}`);
}
const turn = (status: string, items: unknown[] = []) => ({
  id: "{{turn}}",
  status,
  items,
  error: null,
});
const notification = (notify: string, params: unknown): Step => ({ notify, params });
const itemCompleted = (body: unknown) =>
  notification(Method.itemCompleted, { threadId: "{{thread}}", turnId: "{{turn}}", item: body });
const completed = (status = "completed") =>
  notification(Method.turnCompleted, { threadId: "{{thread}}", turn: turn(status) });

const threadRule = {
  method: Method.threadStart,
  respond: {
    result: {
      model: "gpt-6.1-sol",
      serviceTier: "priority",
      cwd: "/tmp/fake-repo",
      sandbox: { type: "readOnly", networkAccess: false },
    },
  },
};
function scenario(steps: Step[], extra: Scenario["rules"] = []): Scenario {
  return {
    rules: [
      threadRule,
      {
        method: Method.turnStart,
        respond: { result: { turn: { status: "inProgress", items: [], error: null } } },
        steps,
      },
      ...extra,
    ],
  };
}

export function successfulTurn(): Scenario {
  return scenario([
    notification(Method.turnStarted, { threadId: "{{thread}}", turn: turn("inProgress") }),
    itemCompleted(item("commandExecution")),
    itemCompleted({
      type: "fileChange",
      id: "file-{{seq}}",
      status: "completed",
      changes: [{ path: "result.txt", kind: { type: "add" }, diff: "+hello" }],
    }),
    notification(Method.tokenUsageUpdated, {
      ...recorded(Method.tokenUsageUpdated),
      threadId: "{{thread}}",
      turnId: "{{turn}}",
    }),
    itemCompleted({ ...item("agentMessage"), text: "Created result.txt.", phase: "final_answer" }),
    completed(),
  ]);
}

const toolRequest = (): Step => ({
  request: Method.toolCall,
  label: "question",
  params: { ...recorded(Method.toolCall), threadId: "{{thread}}", turnId: "{{turn}}" },
});
const toolItem = (status: string) => ({
  ...item("dynamicToolCall", status),
  id: recorded(Method.toolCall).callId,
  arguments: recorded(Method.toolCall).arguments,
});
export function askOrchestrator(): Scenario {
  return scenario(
    [
      toolRequest(),
      { awaitResponse: "question" },
      itemCompleted(toolItem("completed")),
      completed(),
    ],
    [{ method: Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } }],
  );
}

export function interruptedTurn(): Scenario {
  return scenario(
    [
      toolRequest(),
      { awaitRequest: Method.turnInterrupt },
      itemCompleted(toolItem("failed")),
      { stderr: "dynamic tool call was cancelled before receiving a response" },
      completed("interrupted"),
    ],
    [
      { method: Method.turnInterrupt, respond: { result: {} } },
      // A later response has no rule and is only logged, just as the real server silently drops it.
      { method: Method.turnSteer, respond: { result: { turnId: "{{turn}}" } } },
    ],
  );
}

export function blockedCommand(): Scenario {
  const hook = recorded(
    Method.hookCompleted,
    Schema.Struct({ run: Schema.Struct({ status: Schema.Literal("blocked") }) }),
  );
  return scenario([
    notification(Method.hookStarted, {
      ...hook,
      threadId: "{{thread}}",
      turnId: "{{turn}}",
      run: {
        ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(hook.run),
        status: "running",
        entries: [],
      },
    }),
    notification(Method.hookCompleted, { ...hook, threadId: "{{thread}}", turnId: "{{turn}}" }),
    itemCompleted(item("agentMessage")),
    completed(),
  ]);
}

export const crash = (code = 17): Scenario => ({
  rules: [{ method: Method.turnStart, respond: "none", steps: [{ exit: code }] }],
});

export function repoHooks(cwd: string, hooksFile: string, trustStatus = "trusted"): Scenario {
  return {
    rules: [
      {
        method: Method.hooksList,
        repeat: true,
        when: { cwds: [cwd] },
        respond: {
          result: {
            data: [
              {
                cwd,
                hooks: [
                  {
                    key: "/home/dev/.codex/hooks.json:stop:0:0",
                    source: "user",
                    currentHash: "sha256:user",
                    trustStatus: "untrusted",
                  },
                  {
                    key: `${hooksFile}:pre_tool_use:0:0`,
                    source: "project",
                    currentHash: "sha256:fixture",
                    trustStatus,
                  },
                ],
                warnings: [],
                errors: [],
              },
            ],
          },
        },
      },
    ],
  };
}

export const trustedHooks = (cwd: string, file: string) => repoHooks(cwd, file);
export const untrustedHooks = (cwd: string, file: string) => repoHooks(cwd, file, "untrusted");
export const modifiedHooks = (cwd: string, file: string) => repoHooks(cwd, file, "modified");
export const missingProjectHooks = (cwd: string): Scenario => ({
  rules: [
    {
      method: Method.hooksList,
      repeat: true,
      respond: {
        result: {
          data: [
            {
              cwd,
              hooks: [
                {
                  key: "/home/dev/.codex/hooks.json:stop:0:0",
                  source: "user",
                  currentHash: "sha256:user",
                  trustStatus: "trusted",
                },
              ],
              warnings: [],
              errors: [],
            },
          ],
        },
      },
    },
  ],
});
