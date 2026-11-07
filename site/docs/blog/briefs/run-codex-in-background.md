- Slug: `run-codex-in-background`. Feature: `background`.
- Primary query: run Codex in background
- Secondary: codex background task; codex long running task; check on codex progress; codex exec background
- Intent: start a Codex task, keep working, and find out when it's done or stuck, without babysitting a terminal.
- SERP notes: community guides background `codex exec` with logs and polling; Codex app automations; OpenAI's plugin has `--background` jobs.
- Angle: native options first, accurately (sheet: `codex exec` in a background shell, the shared app-server daemon and `codex agents`, `codex queue` for an existing session, `codex resume`, the plugin's `--background` with `/codex:status` and `/codex:result`). Then the questions that matter for long tasks: does the task survive the shell that started it, how do you see progress, can you steer it mid-turn, what bounds its runtime, how do you learn it finished. foreman's answers from the sheet: runs belong to the daemon not the CLI call, `status`/`events`, `steer`, `--budget` (default 60m) with a read-only hand-off turn when time runs out, `--wait` returning on attention, daemon idle exit and what happens when the app-server dies (state it plainly).
- H2s:
  1. How do you run Codex in the background?
  2. Native ways to background a Codex task
  3. How do you check on a running Codex task?
  4. Can you change a task's direction while it runs?
  5. What stops a background task from running forever?
- CommandDemo: `status-release` in H2 3, caption like "status shows each run's state, model and last activity."
- Suggested title: "Run Codex in the background" (27). Keyword phrase "run Codex in background" must appear verbatim once in the first 100 words.
