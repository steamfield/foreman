- Slug: `codex-plugin-for-claude-code`. Feature: `delegation`.
- Primary query: Codex plugin for Claude Code
- Secondary: codex-plugin-cc; /codex:rescue; install codex plugin claude code; codex review claude code plugin
- Intent: install and use OpenAI's plugin, or decide whether it fits.
- SERP notes: the GitHub repo and directory listings rank; few guides. Navigational intent, so the post must be the clearest install-and-use guide, with foreman as one honest comparison section.
- Angle: everything in the sheet's plugin section, accurately and in order: requirements, the four install steps, `/codex:setup`, review vs adversarial review, rescue with its flags, background jobs and status/result/cancel, transfer, the review gate and its usage warning. Then "When is the plugin enough?" (reviews, one-off rescues, handing off a session) and "When does a supervised worktree workflow fit?" (several implementation tasks at once, each in its own worktree with a contract, questions routed back, review before commit: foreman). No claims about the plugin's internals beyond the README. Don't call it worse; describe different jobs.
- H2s:
  1. What is the Codex plugin for Claude Code?
  2. How do you install the Codex plugin?
  3. Reviews: /codex:review and /codex:adversarial-review
  4. Delegating work with /codex:rescue
  5. Background jobs, status and results
  6. When does a worktree-per-task workflow fit better?
- CommandDemo: none.
- Suggested title: "Codex plugin for Claude Code: a guide" (37).
