import type { AcpRule, AcpScenario, Step } from "./scenario";

// Scenario builders for the fake agy, with message shapes taken from agy 1.5.14
// (tests/fixtures/agy-1.5.14.jsonl).

const update = (body: Record<string, unknown>): Step => ({
  notify: "session/update",
  params: { sessionId: "{{session}}", update: body },
});

/** A shell command agy runs itself: start, then completion with output and exit code. */
export function command(
  commandLine: string,
  output: string,
  exitCode = 0,
  id = `call_cmd_${commandLine.length}`,
): Step[] {
  const call = {
    toolCallId: id,
    name: "run_command",
    args: { CommandLine: commandLine, WaitMsBeforeAsync: 5000 },
    kind: "execute",
    title: commandLine,
  };
  return [
    update({ sessionUpdate: "tool_call", ...call, status: "in_progress" }),
    update({
      sessionUpdate: "tool_call_update",
      ...call,
      status: exitCode === 0 ? "completed" : "failed",
      rawOutput: { output: `Command output:\n${output}`, exit_code: exitCode },
    }),
  ];
}

/** An edit agy makes with its own tool, writing the file for real. */
export function edit(file: string, text: string): Step[] {
  const path = `{{cwd}}/${file}`;
  const call = {
    toolCallId: `call_edit_${file}`,
    name: "write_file",
    args: { Path: path, Content: text },
    kind: "edit",
    title: `File ${file}`,
    locations: [{ path }],
  };
  return [
    update({ sessionUpdate: "tool_call", ...call, status: "in_progress" }),
    { writeFile: path, text },
    update({
      sessionUpdate: "tool_call_update",
      ...call,
      status: "completed",
      content: [{ type: "diff", path, newText: text }],
    }),
  ];
}

/** agy asks before a tool call (default mode); the fake waits for foreman's decision. */
export function permission(label: string, kind: string, title: string, name: string): Step[] {
  return [
    {
      request: "session/request_permission",
      label,
      params: {
        sessionId: "{{session}}",
        toolCall: { toolCallId: `call_${label}`, name, kind, title, status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    },
    { awaitResponse: label },
  ];
}

export function message(text: string): Step {
  return update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

const usage = {
  inputTokens: 1000,
  outputTokens: 50,
  cachedReadTokens: 200,
  cachedWriteTokens: 0,
  thoughtTokens: 10,
  totalTokens: 1260,
};

/** A prompt rule: plays the steps, then ends the turn with the stop reason. */
export function prompt(steps: Step[], stopReason = "end_turn", repeat = false): AcpRule {
  return {
    method: "session/prompt",
    respondAfterSteps: true,
    ...(repeat ? { repeat } : {}),
    respond: { result: { stopReason, usage } },
    steps,
  };
}

/** A write turn: approved command and edit, a closing message. */
export function writeTurn(): AcpScenario {
  return {
    rules: [
      prompt([
        ...permission("cmd", "execute", "git status --short", "run_command"),
        ...command("git status --short", ""),
        ...permission("edit", "edit", "File result.txt", "write_file"),
        ...edit("result.txt", "hello\n"),
        message("Created result.txt."),
      ]),
      prompt([message("Follow-up done.")], "end_turn", true),
    ],
  };
}

/** agy asks to edit; a read-only run refuses, and agy ends the turn with no message. */
export function refusedEdit(): AcpScenario {
  return {
    rules: [
      prompt([
        message("Reading first."),
        ...permission("edit", "edit", "File result.txt", "write_file"),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_edit",
          kind: "edit",
          status: "failed",
        }),
      ]),
    ],
  };
}

/** A long command that only ends when foreman cancels the session. */
export function cancellableTurn(): AcpScenario {
  return {
    rules: [
      prompt(
        [
          update({
            sessionUpdate: "tool_call",
            toolCallId: "call_sleep",
            name: "run_command",
            args: { CommandLine: "sleep 600" },
            kind: "execute",
            title: "sleep 600",
            status: "in_progress",
          }),
          { awaitRequest: "session/cancel" },
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "call_sleep",
            kind: "execute",
            status: "failed",
          }),
        ],
        "cancelled",
      ),
    ],
  };
}

/** A command, then a long closing message in many chunks, all written in one burst. */
export function longHandoff(chunks: number): AcpScenario {
  const words = Array.from({ length: chunks }, (_, index) => message(`w${index} `));
  return { rules: [prompt([...command("ls", "a.txt\n"), ...words])] };
}

/** agy offers only `allow_always` and `reject_once` for an edit, then ends the turn. */
export function allowAlwaysOnly(): AcpScenario {
  return {
    rules: [
      prompt([
        {
          request: "session/request_permission",
          label: "edit",
          params: {
            sessionId: "{{session}}",
            toolCall: {
              toolCallId: "call_edit",
              name: "write_file",
              kind: "edit",
              title: "File result.txt",
              status: "pending",
            },
            options: [
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        },
        { awaitResponse: "edit" },
      ]),
    ],
  };
}

const ASK_TOOL = "mcp_foreman_ask_orchestrator";
const ASK_SUMMARY = "Ask the orchestrator";

/** agy's tool call for ask_orchestrator, as its session/update reports it. */
const askCall = (label: string, question: string) => ({
  toolCallId: `call_ask_${label}`,
  name: ASK_TOOL,
  args: { question, toolSummary: ASK_SUMMARY },
  kind: "other",
  title: `Run ${ASK_TOOL}`,
  rawInput: { question, toolSummary: ASK_SUMMARY },
});

/**
 * agy calls ask_orchestrator through foreman's MCP bridge: the tool call starts, foreman
 * approves it, and the fake calls the tool with agy's extra `toolSummary` argument. The call
 * stays open while later steps play; finish it with `askEnd`.
 */
export function askStart(label: string, question: string): Step[] {
  return [
    update({ sessionUpdate: "tool_call", ...askCall(label, question), status: "in_progress" }),
    ...permission(`${label}-permission`, "other", `Run ${ASK_TOOL}`, ASK_TOOL),
    {
      mcpCall: {
        tool: "ask_orchestrator",
        arguments: { question, toolSummary: ASK_SUMMARY },
        label,
      },
    },
  ];
}

/** Waits for the bridge's tool result, then reports the tool call ended with `status`. */
export function askEnd(label: string, question: string, status = "completed"): Step[] {
  return [
    { awaitMcpResult: { label } },
    update({ sessionUpdate: "tool_call_update", ...askCall(label, question), status }),
  ];
}

/** A turn that asks one question, waits for the tool result and finishes. */
export function questionTurn(question: string): AcpScenario {
  return {
    rules: [
      prompt([
        ...askStart("q", question),
        ...askEnd("q", question),
        message("Done after the answer."),
      ]),
    ],
  };
}

/** A pair of gate files; `release` must be a FIFO the test writes to open the gate. */
export interface Gate {
  readonly ready: string;
  readonly release: string;
}

/**
 * A turn that asks, waits at `held` until the test saw the question waiting, kills the bridge
 * child mid-call, then waits at `resume` before finishing. A repeating rule takes follow-ups,
 * such as the late answer.
 */
export function abandonedQuestionTurn(question: string, held: Gate, resume: Gate): AcpScenario {
  return {
    rules: [
      prompt([
        ...askStart("q", question),
        { gate: held },
        { killMcp: "q" },
        ...askEnd("q", question, "failed"),
        { gate: resume },
        message("Continued without the answer."),
      ]),
      prompt([message("Applied the late answer.")], "end_turn", true),
    ],
  };
}

/** The prompt replies first; then agy calls the tool with no prompt outstanding. */
export function askAfterTurn(question: string): AcpScenario {
  return {
    rules: [
      {
        method: "session/prompt",
        respond: { result: { stopReason: "end_turn", usage } },
        steps: [
          { mcpCall: { tool: "ask_orchestrator", arguments: { question }, label: "late" } },
          { awaitMcpResult: { label: "late" } },
        ],
      },
    ],
  };
}

/**
 * A turn that works until foreman cancels it (the budget), then a hand-off turn in which agy
 * asks permission to call ask_orchestrator before writing its hand-off.
 */
export function askInHandoff(question: string): AcpScenario {
  return {
    rules: [
      prompt([...command("ls", "a.txt\n"), { awaitRequest: "session/cancel" }], "cancelled"),
      prompt([
        update({ sessionUpdate: "tool_call", ...askCall("h", question), status: "in_progress" }),
        ...permission("h-permission", "other", `Run ${ASK_TOOL}`, ASK_TOOL),
        message("Hand-off: listed a.txt."),
      ]),
    ],
  };
}

/**
 * A turn that runs `ls` and waits for foreman to steer it. The steer's prompt merges into the
 * turn (the fake replies end_turn to the first prompt), runs `git log`, waits at `held` until
 * the test opens it, then writes the closing message. A repeating rule takes follow-ups.
 */
export function steeredTurn(held: Gate): AcpScenario {
  return {
    rules: [
      prompt([
        ...command("ls", "a.txt\n"),
        message("Listing done; waiting for more."),
        { awaitRequest: "session/prompt" },
      ]),
      prompt([
        ...command("git log --oneline", "abc123 initial\n"),
        { gate: held },
        message("Applied the steer."),
      ]),
      prompt([message("Follow-up done.")], "end_turn", true),
    ],
  };
}

/** `count` quick shell commands with distinct tool call ids, all written in one burst. */
export function commandBurst(count: number): Step[] {
  return Array.from({ length: count }, (_, index) =>
    command(`echo ${index}`, `${index}\n`, 0, `call_burst_${index}`),
  ).flat();
}

/**
 * A turn that asks (the test lets the question time out into a deferral), then floods foreman
 * with `burst` commands so the supervisor is still applying them when the prompt replies, and
 * writes `marker` just before the reply. A repeating rule takes the follow-up.
 */
export function lateAnswerAfterTurn(question: string, marker: string, burst: number): AcpScenario {
  return {
    rules: [
      prompt([
        ...askStart("q", question),
        ...askEnd("q", question),
        ...commandBurst(burst),
        message("Finished without the answer."),
        { writeFile: marker, text: "replying" },
      ]),
      prompt([message("Applied the late answer.")], "end_turn", true),
    ],
  };
}

/**
 * A turn that works until foreman cancels it (the budget), then a hand-off turn in which agy
 * runs `git status` (asking first), writes its hand-off, and then asks to edit a file.
 */
export function editInHandoff(): AcpScenario {
  return {
    rules: [
      prompt([...command("ls", "a.txt\n"), { awaitRequest: "session/cancel" }], "cancelled"),
      prompt([
        ...permission("cmd", "execute", "git status --short", "run_command"),
        ...command("git status --short", ""),
        message("Hand-off: listed a.txt; notes.txt not written."),
        ...permission("edit", "edit", "File notes.txt", "write_file"),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call_edit",
          kind: "edit",
          status: "failed",
        }),
      ]),
    ],
  };
}

/**
 * A turn whose first prompt answers and replies end_turn at once, so a steer sent right after
 * it races that reply, then a prompt that gives the steer's answer.
 */
export function steerRacesReply(): AcpScenario {
  return {
    rules: [prompt([message("First answer.")]), prompt([message("Second answer.")])],
  };
}
