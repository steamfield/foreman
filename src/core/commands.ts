import { Effect } from "effect";
import { AppConfig } from "../config";
import { call } from "../daemon/client";
import type { DaemonRequestBody, DaemonResult, QuestionId, RunName } from "../schemas/daemon";
import { Output } from "../services/output";
import { durationMs, type MessageInput, messageText, readText, realPath } from "./command-input";
import { formanExecutable } from "./command-output";

const request = Effect.fn("commands.request")(function* (body: DaemonRequestBody) {
  const config = yield* AppConfig;
  yield* config.load;
  const output = yield* Output;
  return yield* call(body, {
    dataDir: config.home,
    codexBin: config.codexBin,
    codexHome: config.codexHome,
    logFile: (yield* config.logging).file,
    onOutdated: output.note("Daemon is outdated; it will be replaced once its runs finish."),
  });
});

interface WaitOptions {
  readonly wait?: boolean;
  readonly timeout?: string | undefined;
}

const afterAccepted = Effect.fnUntraced(function* (
  result: DaemonResult,
  name: RunName,
  options: WaitOptions,
) {
  if (result._tag !== "Accepted") return result;
  if (options.wait)
    return yield* wait({
      names: [name],
      all: false,
      after: result.cursor,
      timeout: options.timeout,
    });
  const executable = yield* formanExecutable();
  return { ...result, next: `${executable.command} wait ${name} --after ${result.cursor}` };
});

interface StartInput extends WaitOptions {
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
  const started = yield* request({
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
  if (!input.wait || started._tag !== "Started") return started;
  const result = yield* wait({ names: [input.name], all: false, timeout: input.timeout });
  return result._tag === "Waited"
    ? { ...result, started: { name: started.name, runDir: started.runDir } }
    : result;
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
  input: MessageInput & WaitOptions & { name: RunName },
) {
  const result = yield* request({
    _tag: "Steer",
    name: input.name,
    message: yield* messageText(input),
  });
  return yield* afterAccepted(result, input.name, input);
});

export const followup = Effect.fn("commands.followup")(function* (
  input: MessageInput & WaitOptions & { name: RunName; budgetMs?: number; effort?: string },
) {
  const result = yield* request({
    _tag: "Followup",
    name: input.name,
    message: yield* messageText(input),
    ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });
  return yield* afterAccepted(result, input.name, input);
});

export const interrupt = Effect.fn("commands.interrupt")(function* (
  input: WaitOptions & { name: RunName },
) {
  const result = yield* request({ _tag: "Interrupt", name: input.name });
  return yield* afterAccepted(result, input.name, input);
});

export const answer = Effect.fn("commands.answer")(function* (
  input: MessageInput & WaitOptions & { name: RunName; question: QuestionId },
) {
  const result = yield* request({
    _tag: "Answer",
    name: input.name,
    question: input.question,
    text: yield* messageText(input),
  });
  return yield* afterAccepted(result, input.name, input);
});

export const result = (name: RunName) => request({ _tag: "Result", name });

export const archive = (name: RunName) => request({ _tag: "Archive", name });

export const wait = Effect.fn("commands.wait")(function* (
  input: Omit<Extract<DaemonRequestBody, { _tag: "Wait" }>, "_tag" | "cwd" | "timeoutMs"> & {
    timeout: string | undefined;
  },
) {
  const result = yield* request({
    _tag: "Wait",
    names: input.names,
    all: input.all,
    timeoutMs: input.timeout === undefined ? 60 * 60_000 : yield* durationMs(input.timeout),
    ...(input.after === undefined ? {} : { after: input.after }),
    cwd: yield* realPath("."),
  });
  if (result._tag !== "Waited") return result;
  const executable = yield* formanExecutable();
  return {
    ...result,
    next:
      result.next.replace(/^forman(?= )/, () => executable.command) +
      (input.timeout === undefined ? "" : ` --timeout ${input.timeout}`),
  };
});
