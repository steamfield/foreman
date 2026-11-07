- Slug: `codex-waiting-for-input`. Feature: `questions`.
- Primary query: Codex waiting for input
- Secondary: codex stuck waiting for approval; codex asks question non-interactive; codex exec approval prompt; coding agent needs clarification
- Intent: Codex stopped and seems to want something; the reader wants to know what and how to keep it moving.
- SERP notes: thin; mostly GitHub issues and forum threads. Low competition, modest demand. It's foreman's clearest differentiator, so conversion matters more than volume.
- Angle: three different things look like "waiting": (1) an approval prompt from the approval policy (sheet: approval settings, `codex exec` flags), (2) the model asking a clarifying question, (3) a command that's hung (a dev server, an interactive prompt). Diagnose each, and the native fix for each (approval policy and sandbox flags; resuming/queueing a message; avoiding interactive commands). Then the delegation case: in foreman a Codex question becomes `q1` via `ask_orchestrator`, the run shows `waiting`, Claude answers with `answer`, or `defer`s; after 15 minutes the deferral prompt is sent. Quote the deferral prompt's key sentences from the sheet and say plainly it's guidance to the model, not enforcement. Late answers still arrive: they steer a running turn or start a follow-up.
- H2s:
  1. Why is Codex waiting for input?
  2. Is it an approval prompt or a question?
  3. How do you stop Codex asking for approval in non-interactive runs?
  4. What happens to a question nobody answers?
  5. Answering after the agent has moved on
- CommandDemo: `answer` in H2 4 or 5, caption like "Claude answers q1 and the run continues."
- Suggested title: "Codex waiting for input: what it wants" (38).
