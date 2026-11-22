/**
 * The hidden `foreman mcp-question --run <name>` command: agy starts it as the session's MCP
 * server. Claude never runs it. It reads JSON-RPC lines from stdin, answers MCP requests on
 * stdout and holds each `ask_orchestrator` call on the daemon's `Ask` request. stdout carries
 * protocol only; diagnostics go through the logger and are flushed as they happen.
 */
import { Effect, FiberMap, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { AppConfig } from "../config";
import {
  type AskOutcome,
  askReply,
  type McpResponse,
  type McpStep,
  outcomeForError,
  type RequestId,
  stepForLine,
} from "../core/mcp-question";
import { call } from "../daemon/client";
import { detailFor, errorClasses } from "../errors";
import { Logging } from "../logging";
import { RunName } from "../schemas/daemon";
import { Host } from "../services/host";
import { Invocation } from "../services/invocation";
import { Output } from "../services/output";

type AskStep = Extract<McpStep, { _tag: "Ask" }>;

/** The tag and detail of a failed `Ask`, for the log record. */
const describeFailure = (error: unknown): string => {
  const known = errorClasses.find((Class) => error instanceof Class);
  if (known === undefined || !(error instanceof known)) return String(error);
  const detail = detailFor(error);
  return detail === undefined ? error._tag : `${error._tag}: ${detail}`;
};

/**
 * Logs a warning and writes it out at once: the bridge lives as long as agy's session and may be
 * killed, so nothing waits for the end-of-command flush.
 */
const warnNow = Effect.fnUntraced(function* (message: string, annotations: Record<string, string>) {
  yield* Effect.logWarning(message).pipe(Effect.annotateLogs(annotations));
  const logging = yield* Logging;
  const config = yield* AppConfig;
  yield* logging.flush(yield* config.logging);
});

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
    yield* warnNow("mcp-question.unexpected-reply", { run, reply: settled.success._tag });
    return { _tag: "Unavailable" } satisfies AskOutcome;
  }
  const outcome = outcomeForError(settled.failure);
  if (outcome._tag === "Unavailable")
    yield* warnNow("mcp-question.daemon-unavailable", {
      run,
      error: describeFailure(settled.failure),
    });
  return outcome;
});

/**
 * Serves MCP over stdin and stdout for `run` until stdin closes. Each `ask_orchestrator` call is
 * held in its own fiber, so a held question doesn't block a ping; `notifications/cancelled` and
 * the end of stdin interrupt held calls, closing their sockets so the daemon records the
 * abandon at once.
 */
const serveQuestions = Effect.fn("mcpQuestion.serve")(function* (run: RunName) {
  const stdio = yield* Stdio.Stdio;
  const output = yield* Output;
  const host = yield* Host;
  const asks = yield* FiberMap.make<
    RequestId,
    void,
    Effect.Error<ReturnType<typeof output.line>>
  >();
  const write = (response: McpResponse) => output.line(JSON.stringify(response));
  const handle = (line: string) => {
    const step = stepForLine(line, host.version);
    switch (step._tag) {
      case "Reply":
        return write(step.response);
      case "Ask":
        return FiberMap.run(
          asks,
          step.id,
          Effect.flatMap(askDaemon(run, step), (outcome) => write(askReply(step.id, outcome))),
        ).pipe(Effect.asVoid);
      case "Cancel":
        return FiberMap.remove(asks, step.id);
      case "Ignore":
        return Effect.void;
      case "Malformed":
        return warnNow("mcp-question.malformed-line", { run, detail: step.detail });
    }
  };
  const readStdin = stdio.stdin.pipe(
    // A stdin read failure is unexpected for a pipe agy owns; it surfaces as a defect.
    Stream.orDie,
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.runForEach(handle),
  );
  // A held call that fails to write its reply ends the bridge with that failure.
  yield* Effect.raceFirst(readStdin, FiberMap.join(asks));
  yield* FiberMap.clear(asks);
}, Effect.scoped);

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
