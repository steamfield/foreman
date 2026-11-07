- Slug: `codex-hooks-not-trusted`. Feature: `hooks`.
- Primary query: Codex hooks not trusted
- Secondary: codex hooks.json not running; codex /hooks trust; codex project hooks skipped; codex hooks worktree
- Intent: the reader added `.codex/hooks.json` and the hooks don't run (or a tool refuses because they aren't trusted).
- SERP notes: official hooks docs on developers.openai.com and learn.chatgpt.com rank; one detailed third-party post. Troubleshooting angle is thin.
- Angle: troubleshooting walk-through from the sheet's hooks facts: where hooks are loaded from, project trust must be granted for `.codex/` to load, each hook definition is trusted by hash so an edit re-triggers review, `/hooks` to review and trust, the one-off bypass flag (and why not to use it routinely). Linked worktrees: say only what the sheet supports. Then why it matters for delegation: guard hooks (e.g. blocking destructive commands) only protect you if they run, so foreman refuses `start` when the repo's hooks aren't trusted and interrupts a turn if commands run before the hooks did; `foreman doctor` reports hook trust (CommandDemo).
- H2s:
  1. Why are my Codex hooks not trusted?
  2. Where does Codex load hooks from?
  3. How do you trust hooks with /hooks?
  4. Why did my hooks stop running after an edit?
  5. Making sure delegated runs keep their hooks
- CommandDemo: `doctor` in H2 5, caption like "doctor reports each repo hook's trust before any run starts."
- Suggested title: "Codex hooks not trusted: how to fix it" (38).
