- Slug: `antigravity-cli-with-claude-code`. Feature: `providers`.
- Primary query: Antigravity CLI with Claude Code
- Secondary: agy acp; agy Claude Code; Antigravity hooks.json; Antigravity CLI read-only; agy sign in
- Intent: someone who already decided to drive agy from Claude Code and wants the mechanics: the protocol, signing in, which repo files agy reads, what read-only means, and why questions time out sooner.
- SERP notes (2026-11-22, no volume data): Google's Antigravity docs (getting started, ACP, hooks, rules) and editor integration pages. Nothing covers agy driven by another agent. The pillar owns "Gemini from Claude Code"; this post owns agy mechanics.
- Angle: reference-flavored explainer, ordered by what a first run hits. `agy acp` is a JSON-RPC stdio server an editor (or foreman) launches; sign in once interactively or with `agy acp --login`, and credentials are reused. Repo files: `.agents/hooks.json` (no trust step, committed copy matters; foreman refuses a start when a repo has only Codex hooks), `AGENTS.md`/`GEMINI.md`/`.agents/rules/` loaded up to the repo root. Read-only: foreman refuses agy edit tools but approves shell; the run fails if shell changed files; use Codex for an OS-sandboxed read-only run. Questions: 100 s cap under agy's measured 180 s hold. Name only `run_command` among agy tool names (fact sheet disagreement).
- H2s:
  1. How does the Antigravity CLI work with Claude Code?
  2. agy acp and the Agent Client Protocol
  3. Signing in without an API key
  4. Repo hooks in .agents/hooks.json
  5. Rules and instructions agy reads
  6. What read-only means on agy
  7. Why agy questions time out after 100 seconds
- CommandDemo: none (no agy recording; doctor's recording predates agy).
- Links: `/docs/providers`, `/#install`, pillar `/blog/run-gemini-from-claude-code`.
- Suggested title: "Antigravity CLI with Claude Code" (32). Headline: "Using the Antigravity CLI (agy) with Claude Code: protocol, sign-in, hooks and limits".
