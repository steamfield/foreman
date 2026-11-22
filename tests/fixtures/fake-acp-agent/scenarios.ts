import type { AcpRule, AcpScenario, Step } from "./scenario";

// Scenario builders for the fake agy, with message shapes taken from agy 1.5.14
// (tests/fixtures/agy-1.5.14.jsonl).

const update = (body: Record<string, unknown>): Step => ({
  notify: "session/update",
  params: { sessionId: "{{session}}", update: body },
});

/** A shell command agy runs itself: start, then completion with output and exit code. */
export function command(commandLine: string, output: string, exitCode = 0): Step[] {
  const id = `call_cmd_${commandLine.length}`;
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
