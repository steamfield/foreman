- Slug: `gemini-neon-subagent-claude-code`. Feature: `providers`.
- Primary query: Gemini Neon subagent in Claude Code
- Secondary: Gemini 4 Neon Claude Code; use Gemini as a Claude Code subagent; Claude Code subagent different model; mix Codex and Gemini agents
- Intent: a Claude Code user wants a subagent-like helper that runs on Gemini 4 Neon (or another non-Claude model) and to pick the model per task, possibly running Codex and Gemini side by side.
- SERP notes (2026-11-22, no volume data): Claude Code subagent docs (which run Claude models), community routers and proxy setups, model-release posts. No result shows choosing a model per task across Codex and agy catalogs from one session.
- Angle: task walkthrough. Find the ids (`agy models`, `foreman models` with both catalogs, effort columns, `fixed`); pick a model per run with `--model gemini-4-neon --effort high` or the suffixed `gemini-4-neon-high` (same run); `codex:`/`agy:` prefixes for ambiguous ids; agy never chosen by default, `defaultModel` can name it; `--tier` Codex-only. Then two runs, one Codex and one Gemini, supervised with one `foreman wait --all`. Be clear these are foreman runs in worktrees, not Claude Code's built-in subagents. No claims about which model suits which task.
- H2s:
  1. How do you run a Gemini Neon subagent in Claude Code?
  2. Finding the model ids
  3. Choosing the model and effort for one run
  4. When a model name needs a provider prefix
  5. Running Codex and Gemini side by side
  6. Defaults and limits to know
- CommandDemo: `wait-all` in H2 5, captioned as a recorded Codex group wait. The captured `models.json` can't be replayed until `src/data/commands.ts` registers it; describe the catalog in prose.
- Links: `/docs/providers`, `/#install`, pillar `/blog/run-gemini-from-claude-code`, `/blog/run-multiple-codex-agents`.
- Suggested title: "Gemini Neon subagent in Claude Code" (35). Headline: "Run a Gemini Neon subagent in Claude Code and pick a model per task".
