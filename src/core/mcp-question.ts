/**
 * `foreman mcp-question`: the stdio MCP server agy launches per session, exposing
 * `ask_orchestrator` and forwarding each call to the daemon's `Ask` request.
 * docs/rfcs/0002-providers.md "Questions on agy" is the design.
 */
import { Effect } from "effect";
import type { RunName } from "../schemas/daemon";

/**
 * Serves MCP over stdin and stdout for `run` until stdin closes. Each `ask_orchestrator` call
 * is held on the daemon socket until the run answers, defers or refuses it.
 */
export const runQuestionBridge = (run: RunName): Effect.Effect<void> =>
  Effect.die(`not implemented: runQuestionBridge(${run})`);
