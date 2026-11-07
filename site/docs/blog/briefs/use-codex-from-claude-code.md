- Slug: `use-codex-from-claude-code`. Feature: `delegation`.
- Primary query: use Codex from Claude Code
- Secondary: claude code codex integration; delegate tasks from claude code to codex; claude code and codex together; call codex from claude code
- Intent: a Claude Code user with a ChatGPT plan wants Claude to hand coding work to Codex without copy-pasting between terminals.
- SERP notes (2026-11-06): OpenAI's `openai/codex-plugin-cc`, several community plugins/skills shelling out to `codex exec`, and "Claude Code vs Codex" comparison posts. Readers comparing tools also want "use both" guidance; this post owns that intent.
- Angle: pillar. Three real ways, from least to most setup: (1) Claude Code runs `codex exec` through Bash (fact sheet: Codex CLI / exec), (2) OpenAI's Codex plugin (`/codex:rescue`, `/codex:review`, background jobs; fact sheet: plugin section), (3) foreman (contract per task, own worktree, daemon-owned turns, questions routed back to Claude, review before commit). Compare them on: where the work runs (checkout vs worktree), what happens on a long task, what happens when Codex has a question, and who reviews and commits. Be fair to the plugin: it covers reviews and background delegation; foreman is for supervised implementation runs, often several at once. Prerequisites section from the fact sheet (Codex CLI version, `codex login`, macOS/Linux for foreman). No auth-enforcement claims (sheet marks ChatGPT-only enforcement not verified).
- H2s:
  1. How do you use Codex from Claude Code?
  2. Running codex exec from Claude Code's shell
  3. What does OpenAI's Codex plugin for Claude Code do?
  4. When should Claude Code delegate to Codex in a worktree?
  5. What happens when Codex has a question mid-task?
  6. What you need installed
- CommandDemo: `start-wait` in H2 4, caption like "Claude starts a Codex run in its own worktree and waits for it to need attention."
- Suggested title: "Use Codex from Claude Code" (26). Headline may expand ("How to use Codex from Claude Code: three ways to delegate").
