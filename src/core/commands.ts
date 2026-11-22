import { Effect, type PlatformError, type Schema } from "effect";
import { AppConfig } from "../config";
import { call, outdated, passiveEvents, probe } from "../daemon/client";
import { type AppError, PermissionDenied, RunConflict, RunNotFound, Usage } from "../errors";
import { resolveModel } from "../providers/routing";
import {
  activeStates,
  type DaemonRequestBody,
  type DaemonResult,
  type QuestionId,
  type RunName,
} from "../schemas/daemon";
import { Host } from "../services/host";
import { Output } from "../services/output";
import { durationMs, type MessageInput, messageText, readText, realPath } from "./command-input";
import { foremanExecutable, renderEventLines } from "./command-output";
import { modelCatalogs } from "./models";
import * as Store from "./runs/store";
import { validateStartMode } from "./start-mode";

const request = Effect.fn("commands.request")(function* (
  body: DaemonRequestBody,
  onOutdated?: Effect.Effect<void, AppError>,
) {
  const config = yield* AppConfig;
  yield* config.load;
  const output = yield* Output;
  return yield* call(body, {
    dataDir: config.home,
    codexBin: config.codexBin,
    agyBin: config.agyBin,
    codexHome: config.codexHome,
    logFile: (yield* config.logging).file,
    onOutdated:
      onOutdated ??
      output.note(
        output.json
          ? JSON.stringify({
              notice: {
                tag: "DaemonOutdated",
                message: "Daemon is outdated; it will be replaced once its runs finish.",
              },
            })
          : "Daemon is outdated; it will be replaced once its runs finish.",
      ),
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
  const executable = yield* foremanExecutable();
  return {
    ...result,
    next: `${executable.command} wait ${name} --after ${result.cursor}`,
  };
});

interface StartInput extends WaitOptions {
  readonly name: RunName;
  readonly worktree: string | undefined;
  readonly newWorktree: boolean;
  readonly from: string | undefined;
  readonly setup: string | undefined;
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
  yield* validateStartMode(input);
  // Routed before the daemon is contacted, so a wrong model costs no worktree or run.
  const routed = yield* resolveModel(
    {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.tier === undefined ? {} : { tier: input.tier }),
    },
    yield* modelCatalogs(),
  );
  const started = yield* request({
    _tag: "Start",
    name: input.name,
    write: input.write,
    skipDepsCheck: input.skipDepsCheck,
    worktree: yield* realPath(input.worktree ?? "."),
    ...(input.newWorktree ? { newWorktree: true } : {}),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.setup === undefined ? {} : { setup: input.setup }),
    contract: yield* readText(input.contract),
    // Omitted for Codex, so a daemon that predates providers accepts every Codex start.
    ...(routed.provider === "codex" ? {} : { provider: routed.provider }),
    ...(routed.model === undefined ? {} : { model: routed.model }),
    ...(routed.effort === undefined ? {} : { effort: routed.effort }),
    ...(routed.tier === undefined ? {} : { tier: routed.tier }),
    ...(input.budgetMs === undefined ? {} : { budgetMs: input.budgetMs }),
    ...(input.questionTimeoutMs === undefined
      ? {}
      : { questionTimeoutMs: input.questionTimeoutMs }),
  });
  if (!input.wait || started._tag !== "Started") return started;
  const result = yield* wait({ names: [input.name], all: false, timeout: input.timeout });
  return result._tag === "Waited"
    ? {
        ...result,
        started: {
          name: started.name,
          runDir: started.runDir,
          ...(started.worktree ? { worktree: started.worktree, branch: started.branch } : {}),
        },
      }
    : result;
});

export const status = Effect.fn("commands.status")(function* (
  name: RunName | undefined,
  all = false,
) {
  if (all && name !== undefined)
    return yield* new Usage({ detail: "Provide a run name or --all, not both." });
  if (all) return yield* request({ _tag: "Overview" });
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

export const followEvents = Effect.fn("commands.followEvents")(function* (input: {
  name: RunName;
  after?: number;
  limit?: number;
  verbose: boolean;
}) {
  const output = yield* Output;
  if (output.json) return yield* new Usage({ detail: "--follow is text-only; omit --json." });
  const config = yield* AppConfig;
  yield* config.load;
  const host = yield* Host;
  let after = input.after ?? 0;
  const saved = Effect.fnUntraced(function* (reason: string) {
    const dir = yield* Store.runDirectory(config.home, input.name);
    const readError = (error: PlatformError.PlatformError | Schema.SchemaError) => {
      if (error._tag === "PlatformError" && error.reason._tag === "NotFound")
        return new RunNotFound({
          detail: `No saved run named ${input.name} in ${dir}; check the name or start it before retrying.`,
        });
      if (error._tag === "PlatformError" && error.reason._tag === "PermissionDenied")
        return new PermissionDenied({
          detail: `Cannot read saved events for ${input.name} in ${dir}; check file and directory permissions, then retry.`,
        });
      const diagnostic =
        error._tag === "PlatformError" ? error.reason._tag : "invalid or unsupported run data";
      return new RunConflict({
        detail: `Cannot read saved events for ${input.name} in ${dir} (${diagnostic}); preserve and inspect the records before retrying.`,
      });
    };
    yield* Store.readRun(dir).pipe(Effect.mapError(readError));
    while (true) {
      const page = yield* Store.readEvents(dir, after, input.limit).pipe(
        Effect.mapError(readError),
      );
      for (const line of renderEventLines(page, input.verbose)) yield* output.line(line);
      after = page.next;
      if (page.events.length === 0) break;
    }
    yield* output.note(
      `No live daemon is supervising this run, so follow stopped (${reason}). Run foreman status ${input.name} to start one.`,
    );
  });
  const checked = yield* probe(config.home, true).pipe(Effect.result);
  if (checked._tag === "Failure") {
    if (checked.failure._tag === "DaemonUnavailable") return yield* saved("daemon connection lost");
    return yield* checked.failure;
  }
  const pong = checked.success;
  if (pong === null) return yield* saved("no daemon running");
  if (pong._tag !== "Pong" || outdated(pong, host.build, { dataDir: config.home }))
    return yield* saved("daemon is outdated");
  while (true) {
    const polled = yield* passiveEvents(config.home, input.name, after, 15000).pipe(
      // Only encoding our validated request can fail with SchemaError here.
      Effect.catchTag("SchemaError", Effect.die),
      Effect.result,
    );
    if (polled._tag === "Failure") {
      if (polled.failure._tag === "DaemonUnavailable")
        return yield* saved("daemon connection lost");
      return yield* polled.failure;
    }
    const received = polled.success;
    if (received === null || received.state === undefined)
      return yield* saved("daemon does not support live events");
    // passiveEvents has a fixed page size; preserve the CLI's smaller output pages.
    const events = received.events.slice(0, input.limit);
    const page = { ...received, events, next: events.at(-1)?.seq ?? after };
    for (const line of renderEventLines(page, input.verbose)) yield* output.line(line);
    after = page.next;
    if (!activeStates.has(received.state) && page.events.length === 0) return;
  }
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

export const defer = Effect.fn("commands.defer")(function* (
  input: WaitOptions & { name: RunName; question: QuestionId; note: string | undefined },
) {
  const result = yield* request({
    _tag: "Defer",
    name: input.name,
    question: input.question,
    ...(input.note === undefined ? {} : { note: input.note }),
  });
  return yield* afterAccepted(result, input.name, input);
});

export const result = (name: RunName) => request({ _tag: "Result", name });

export const archive = (name: RunName, keepWorktree = false) =>
  request({ _tag: "Archive", name, ...(keepWorktree ? { keepWorktree: true } : {}) });

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
  const executable = yield* foremanExecutable();
  return {
    ...result,
    next:
      result.next.replace(/^foreman(?= )/, () => executable.command) +
      (input.timeout === undefined || !result.next.startsWith("foreman wait ")
        ? ""
        : ` --timeout ${input.timeout}`),
    ...(result.alternative === undefined
      ? {}
      : { alternative: result.alternative.replace(/^foreman(?= )/, () => executable.command) }),
  };
});
