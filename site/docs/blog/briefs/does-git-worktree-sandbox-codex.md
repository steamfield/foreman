- Slug: `does-git-worktree-sandbox-codex`. Feature: `safety`.
- Primary query: does a git worktree sandbox Codex
- Secondary: is git worktree a sandbox; codex sandbox modes; codex workspace-write vs danger-full-access; ai agent isolation git worktree
- Intent: the reader runs agents in worktrees and wants to know whether that protects the rest of the machine.
- SERP notes: worktree-for-agents posts often imply isolation; official Codex docs describe sandbox modes separately. The gap is a plain answer.
- Angle: answer up front: no. A worktree separates working files, index and HEAD; it shares the object store, refs, config and hooks with the main repo (git section), and the process still runs as you on the same host with the same network, credentials, ports and caches. Isolation comes from the sandbox: explain Codex's sandbox modes and approval policies by their official names (sheet). Then foreman, stated up front and plainly: runs are read-only with network off by default; `--write` gives full host access with no approval prompts, and there is no workspace-write mode; the worktree is for keeping changes reviewable, not for containment; repo guard hooks are the remaining layer. Suggest what a reader should do (read-only for audits, trusted repos only for write runs, guard hooks).
- H2s:
  1. Does a git worktree sandbox Codex?
  2. What does a worktree isolate, and what does it share?
  3. What do Codex's sandbox modes do?
  4. Read-only runs versus write runs
  5. What else protects you during a write run?
- CommandDemo: none.
- Suggested title: "Does a git worktree sandbox Codex?" (34).
