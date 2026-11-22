/**
 * The hidden `foreman mcp-question --run <name>` command: agy starts it as the session's MCP
 * server. Claude never runs it. It reads JSON-RPC lines from stdin, answers MCP requests on
 * stdout and holds each `ask_orchestrator` call on the daemon's `Ask` request. stdout carries
 * protocol only; diagnostics go through the logger.
 */
import { Effect, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { AppConfig } from "../config";
import {
  type AskOutcome,
  askReply,
  type McpResponse,
  type McpStep,
  outcomeForError,
  stepForLine,
} from "../core/mcp-question";
import { call } from "../daemon/client";
import { type AppError, detailFor, errorClasses } from "../errors";
import { RunName } from "../schemas/daemon";
import { Host } from "../services/host";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

type AskStep = Extract<McpStep, { _tag: "Ask" }>;

const isAppError = (error: unknown): error is AppError =>
  errorClasses.some((Class) => error instanceof Class);

/** The tag and detail of a failed `Ask`, for the log record. */
const describeFailure = (error: unknown): string => {
  if (!isAppError(error)) return String(error);
  const detail = detailFor(error);
  return detail === undefined ? error._tag : `${error._tag}: ${detail}`;
};

/**
 * Sends one question to the daemon and waits, with no timeout, until the run answers, defers or
 * refuses it. The connect-only client never starts, stops or replaces a daemon from inside agy.
 */
const askDaemon = Effect.fnUntraced(function* (run: RunName, step: AskStep) {
  const config = yield* AppConfig;
  const body = {
    _tag: "Ask" as const,
    name: run,
    question: step.question,
    kind: step.kind,
    callId: crypto.randomUUID(),
  };
  const settled = yield* Effect.result(call(body, { dataDir: config.home, connectOnly: true }));
  if (settled._tag === "Success") {
    if (settled.success._tag === "AskAnswer")
      return { _tag: "Answered", text: settled.success.text } satisfies AskOutcome;
    yield* Effect.logWarning("mcp-question.unexpected-reply").pipe(
      Effect.annotateLogs({ run, reply: settled.success._tag }),
    );
    return { _tag: "Unavailable" } satisfies AskOutcome;
  }
  const error = settled.failure;
  const outcome: AskOutcome = isAppError(error) ? outcomeForError(error) : { _tag: "Unavailable" };
  if (outcome._tag === "Unavailable")
    yield* Effect.logWarning("mcp-question.daemon-unavailable").pipe(
      Effect.annotateLogs({ run, error: describeFailure(error) }),
    );
  return outcome;
});

/** Turns one stdin line into the response to write, or null when it gets none. */
const respondTo = Effect.fnUntraced(function* (run: RunName, line: string) {
  const host = yield* Host;
  const step = stepForLine(line, host.version);
  switch (step._tag) {
    case "Reply":
      return step.response;
    case "Ask":
      return askReply(step.id, yield* askDaemon(run, step));
    case "Ignore":
      return null;
    case "Malformed":
      yield* Effect.logWarning("mcp-question.malformed-line").pipe(
        Effect.annotateLogs({ run, detail: step.detail }),
      );
      return null;
  }
});

/**
 * Serves MCP over stdin and stdout for `run` until stdin closes, then finishes the calls still
 * held. Requests are handled concurrently, so a held question doesn't block a ping.
 */
const serveQuestions = Effect.fn("mcpQuestion.serve")(function* (run: RunName) {
  const stdio = yield* Stdio.Stdio;
  const output = yield* Output;
  const write = (response: McpResponse | null) =>
    response === null ? Effect.void : output.line(JSON.stringify(response));
  yield* stdio.stdin.pipe(
    // A stdin read failure is unexpected for a pipe agy owns; it surfaces as a defect.
    Stream.orDie,
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.mapEffect((line) => Effect.flatMap(respondTo(run, line), write), {
      concurrency: "unbounded",
      unordered: true,
    }),
    Stream.runDrain,
  );
});

/** `foreman mcp-question --run <name>`: agy's `ask_orchestrator` MCP server for one run. */
export const mcpQuestionCommand = Command.make(
  "mcp-question",
  {
    run: Flag.String("run").pipe(
      Flag.withSchema(RunName),
      Flag.withDescription("The agy run whose questions this server forwards."),
    ),
  },
  Effect.fn(function* ({ run }) {
    yield* Effect.flatMap(Invocation, (invocation) => invocation.named("mcp-question"));
    yield* serveQuestions(run);
  }),
).pipe(
  Command.withDescription(
    "Internal: the stdio MCP server foreman passes to agy sessions so agy runs can call ask_orchestrator. agy starts it; don't run it yourself. Exits 0 when stdin closes, 2 for usage, 130 when interrupted, 1 on an internal error.",
  ),
  Command.withShortDescription("Internal: agy's ask_orchestrator MCP server."),
  Command.withExamples([
    {
      command: "foreman mcp-question --run fix-auth",
      description: "What agy runs for run fix-auth's session",
    },
    {
      command: "foreman mcp-question --run fix-auth < requests.jsonl",
      description: "Replay MCP requests by hand when debugging the bridge",
    },
  ]),
);
