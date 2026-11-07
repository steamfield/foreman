- Slug: `run-codex-in-git-worktree`. Feature: `worktrees`.
- Primary query: run Codex in a git worktree
- Secondary: codex git worktree; codex exec --worktree; git worktree add for ai agent; codex worktree node_modules
- Intent: keep Codex's edits off the main checkout while you keep working.
- SERP notes: Codex CLI reference documents `--worktree`; blog posts compare Claude Code and Codex worktree support, some outdated.
- Angle: one checkout, one task. Plain git first (`git worktree add -b`, list, remove, prune; what is per-worktree vs shared, from the git section). Then Codex's own `--worktree` flag (sheet: exec section, local execution only). Then the problems that bite: new worktrees have no dependencies (node_modules etc.), hooks and project trust (one line, link to nothing yet), and removing a worktree with unmerged or dirty work. foreman: `--new-worktree` creates `.claude/worktrees/<name>` on `foreman/<name>`, `--setup` runs install first, a dependency check refuses a worktree without deps, and `archive` refuses to delete unmerged or dirty work (all from the sheet). Keep multi-run supervision to one sentence (it's another post's job).
- H2s:
  1. How do you run Codex in a git worktree?
  2. Creating a worktree with git
  3. Using Codex's built-in worktree option
  4. Why is my new worktree missing dependencies?
  5. Cleaning up without losing unmerged work
- CommandDemo: `archive` in H2 5, caption like "Archiving frees the run's name; foreman refuses while the worktree holds unmerged work."
- Suggested title: "Run Codex in a git worktree" (27).
