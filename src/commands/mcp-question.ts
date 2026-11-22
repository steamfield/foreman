/**
 * The hidden `foreman mcp-question --run <name>` command: agy starts it as the session's MCP
 * server. Claude never runs it.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { runQuestionBridge } from "../core/mcp-question";
import { RunName } from "../schemas/daemon";
import { Invocation } from "../services/invocation";

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
    yield* runQuestionBridge(run);
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
