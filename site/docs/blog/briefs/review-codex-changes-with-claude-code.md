- Slug: `review-codex-changes-with-claude-code`. Feature: `review`.
- Primary query: review Codex changes with Claude Code
- Secondary: review ai generated code before commit; claude code review codex diff; codex changes git diff review
- Intent: Codex finished; the reader wants a reliable way to check its work before it lands.
- SERP notes: generic "review AI code" posts; OpenAI's plugin offers the reverse (Codex reviewing). Little on Claude reviewing Codex's output.
- Angle: a concrete review checklist with git: find the right checkout/branch, `git status` including untracked files, `git diff` against the base, check the diff stays inside what the task allowed, run the project's checks yourself (don't trust the agent's claim that tests pass), ask for a follow-up instead of hand-fixing large problems, commit only after review. Then foreman: `result` prints a digest (state, model, commands run and failed, files written, files outside `- May change:`, new git status entries, tokens) and the hand-off; `followup` continues the same thread; foreman never commits. Mention in one line that the plugin's `/codex:review` goes the other direction.
- H2s:
  1. How do you review Codex changes with Claude Code?
  2. Which files did Codex actually change?
  3. Did it stay inside the task's scope?
  4. Running the checks yourself
  5. Sending it back for fixes
- CommandDemo: `result` in H2 2, caption like "result shows what the run changed, which commands failed and the agent's hand-off."
- Suggested title: "Review Codex changes with Claude Code" (37).
