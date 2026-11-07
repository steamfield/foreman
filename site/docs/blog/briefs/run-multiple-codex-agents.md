- Slug: `run-multiple-codex-agents`. Feature: `parallel`.
- Primary query: run multiple Codex agents in parallel
- Secondary: parallel codex agents; codex multiple tasks at once; run several codex sessions; parallel ai coding agents git worktree
- Intent: the reader has several independent tasks and wants Codex working on them at the same time without the runs colliding.
- SERP notes: "parallel coding agents 2026" roundups, worktree-per-agent DEV posts, vendor tools (Conductor, Superset). Most stop at "one worktree each".
- Angle: worktrees isolate files; the harder parts are choosing tasks that don't touch the same files, starting every run from the same commit, noticing which run needs you, answering questions without losing track, and merging in an order that keeps the tree green. Show the native way first (several `codex exec --worktree` runs or Codex's shared daemon / `codex agents`, per the fact sheet). Then foreman: `start` per task, `wait --all` returns the next event across the repo group with a cursor and a `next:` line, per-run digests, `- May change:` scope flags in the digest (a review aid, not enforcement). Include the measured story from the fact sheet (four delegates, timings) with its source and no extrapolation.
- H2s:
  1. How do you run multiple Codex agents in parallel?
  2. Which tasks are safe to run at the same time?
  3. Giving each agent its own worktree and branch
  4. How do you know which agent needs you?
  5. Merging parallel agents' work back
- CommandDemo: `wait-all` in H2 4, caption like "One wait covers every run in the repository and says what to run next."
- Suggested title: "Run multiple Codex agents in parallel" (37).
