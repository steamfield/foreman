- Slug: `run-gemini-from-claude-code`. Feature: `providers`.
- Primary query: run Gemini from Claude Code
- Secondary: use Gemini from Claude Code; delegate to Gemini from Claude Code; Claude Code Gemini integration; Antigravity CLI Claude Code
- Intent: a Claude Code user with a Google account wants Claude to hand a coding task to a Gemini model without copying prompts between terminals or setting up an API key.
- SERP notes (2026-11-22, no volume data): results are community skills that shell out to a Gemini CLI, MCP wrappers, and "Claude Code vs Gemini" comparisons. None covers agy (the Antigravity CLI) as the delegate with worktree isolation and review. This post owns the broad "Gemini from Claude Code" intent; the agy-specifics and model-choice intents go to the two sibling posts.
- Angle: pillar. Two real ways from least to most setup: (1) Claude Code runs `agy -p` through Bash (local `agy --help`), (2) foreman's agy provider (contract, own worktree, daemon-owned turn, questions routed back to Claude, review before commit). Explain what agy is (Google's Antigravity CLI, terminal client; Google docs) and sign-in (interactive `agy` or `agy acp --login`, browser Google OAuth; foreman strips Gemini and Google key variables so a run uses the sign-in). State the read-only limit plainly (agy read-only refuses edit tools, allows shell). Link the Codex pillar for readers who also use Codex. No Gemini quality, speed or cost claims.
- H2s:
  1. How do you run Gemini from Claude Code?
  2. What is agy, and how do you sign in?
  3. Running agy -p from Claude Code's shell
  4. Delegating to Gemini in its own worktree
  5. What happens when Gemini has a question?
  6. Reviewing the diff before you commit
- CommandDemo: `start-wait` in H2 4, captioned as a Codex run (no agy recording exists; the digest shape is the same on both providers). Switch to an agy recording when one is captured.
- Links: `/docs/providers`, `/#install`, `/blog/use-codex-from-claude-code`, the two sibling posts.
- Suggested title: "Run Gemini from Claude Code" (27). Headline: "How to run Gemini from Claude Code with agy, Google's Antigravity CLI".
