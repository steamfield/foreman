import { Effect } from "effect";
import { AppConfig } from "../config";
import { call } from "../daemon/client";
import type { DaemonRequestBody, QuestionId, RunName } from "../schemas/daemon";
import { type MessageInput, messageText, readText, realPath } from "./command-input";

const request = Effect.fn("commands.request")(function* (body: DaemonRequestBody) {
  const config = yield* AppConfig;
  yield* config.load;
  return yield* call(body, { dataDir: config.dataDir });
});

interface StartInput {
  readonly name: RunName;
  readonly worktree: string;
  readonly contract: string;
  readonly write: boolean;
  readonly skipDepsCheck: boolean;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly tier: string | undefined;
  readonly budgetMs: number | undefined;
  readonly questionTimeoutMs: number | undefined;
}

export const start = Effect.fn("commands.start")(function* (input: StartInput) {
  return yield* request({
    _tag: "Start",
    name: input.name,
    write: input.write,
    skipDepsCheck: input.skipDepsCheck,
    worktree: yield* realPath(input.worktree),
    contract: yield* readText(input.contract),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.tier === undefined ? {} : { tier: input.tier }),
    ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
    ...(input.questionTimeoutMs === undefined
      ? {}
      : { questionTimeoutMs: input.questionTimeoutMs }),
  });
});

export const status = Effect.fn("commands.status")(function* (name: RunName | undefined) {
  return yield* request({
    _tag: "Status",
    ...(name === undefined ? {} : { name }),
    cwd: yield* realPath("."),
  });
});

export const events = (input: { name: RunName; after?: number; limit?: number }) =>
  request({
    _tag: "Events",
    name: input.name,
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });

export const steer = Effect.fn("commands.steer")(function* (
  input: MessageInput & { name: RunName },
) {
  return yield* request({ _tag: "Steer", name: input.name, message: yield* messageText(input) });
});

export const followup = Effect.fn("commands.followup")(function* (
  input: MessageInput & { name: RunName; budgetMs?: number; effort?: string },
) {
  return yield* request({
    _tag: "Followup",
    name: input.name,
    message: yield* messageText(input),
    ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });
});

export const interrupt = (name: RunName) => request({ _tag: "Interrupt", name });

export const answer = Effect.fn("commands.answer")(function* (
  input: MessageInput & { name: RunName; question: QuestionId },
) {
  return yield* request({
    _tag: "Answer",
    name: input.name,
    question: input.question,
    text: yield* messageText(input),
  });
});

export const result = (name: RunName) => request({ _tag: "Result", name });

export const wait = Effect.fn("commands.wait")(function* (
  input: Omit<Extract<DaemonRequestBody, { _tag: "Wait" }>, "_tag" | "cwd">,
) {
  return yield* request({
    _tag: "Wait",
    names: input.names,
    all: input.all,
    timeoutMs: input.timeoutMs,
    ...(input.after === undefined ? {} : { after: input.after }),
    cwd: yield* realPath("."),
  });
});
