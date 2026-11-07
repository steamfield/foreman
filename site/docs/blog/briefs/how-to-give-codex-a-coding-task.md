- Slug: `how-to-give-codex-a-coding-task`. Feature: `contracts`.
- Primary query: how to give Codex a coding task
- Secondary: codex prompt for coding task; AGENTS.md for codex; how to write a task spec for an ai coding agent; codex task instructions
- Intent: get Codex to do the right thing the first time on a real task.
- SERP notes: OpenAI's AGENTS.md docs and prompting guides rank; many generic "prompt engineering for coding agents" posts.
- Angle: two layers. Persistent repo instructions in AGENTS.md (how Codex discovers it and precedence, from the sheet). A per-task brief with: goal (observable behavior), what to read first, files it may change, interface it must not break, acceptance commands, open decisions and when to ask, and the hand-off format. Show a short worked example brief in a code block (a plausible small task, clearly an example). Explain why each part exists (unbounded scope, "tests pass" claims, silent guesses). Then foreman: `foreman guide contract` prints a fillable template, `start --contract`, the `- May change:` line feeding the digest. Don't reproduce the template wholesale; describe its sections.
- H2s:
  1. How do you give Codex a coding task?
  2. What belongs in AGENTS.md and what belongs in the task?
  3. What should a task brief include?
  4. An example brief
  5. How do you tell Codex when to ask instead of guess?
- CommandDemo: none.
- Suggested title: "How to give Codex a coding task" (31).
