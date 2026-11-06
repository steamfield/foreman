import { contractText } from "./contract";
import { contractTestsText } from "./contract-tests";

export const coreText = `The foreman CLI delegates coding tasks to Codex in isolated git worktrees and supervises them through a local daemon.
You write the contract, handle decisions, then review and run the repo's gate before committing or merging.

Before delegating:
- Read AGENTS.md, CLAUDE.md and .claude/delegate.md when present. Keep unresolved design decisions with the orchestrator; do small edits yourself.
- Have the foreman CLI and a signed-in Codex CLI on PATH, and a repo with a commit.
- On first use, open Codex in the main checkout, trust the project if asked and approve its project hooks in /hooks. Run foreman doctor and read every probe even on exit 0.
- Read CODEX_HOME/models_cache.json (default ~/.codex/models_cache.json) and choose a visible model. Use the same literal model for start and the contract's review command; replace gpt-6.1-sol in this example if needed.

The delegation loop (replace doctor-help and the install/gate commands for your repo):
1. foreman guide contract > /tmp/doctor-help-contract.md
   Fill every task placeholder outside the worktree, including the base branch, absolute contract path, checks and review model. Use foreman guide contract tests for a test author.
2. foreman start doctor-help --new-worktree --setup "bun install" --contract /tmp/doctor-help-contract.md --write --model gpt-6.1-sol --wait
   Run this in the background so you remain available; it returns when the run needs attention: a question, or the turn ending. Meanwhile, foreman status doctor-help shows its progress and model.
3. foreman answer doctor-help q1 "The contract's decision" --wait
   Use the actual question id. If it needs a person, use foreman defer instead. Follow printed next: commands in the background until the turn ends.
4. foreman result doctor-help
   Read the hand-off, inspect git diff and git status in its worktree, including new files and outside-scope edits. Refactor as needed.
5. Run the repo's gate yourself in that worktree (here: bun run check), then review and commit or merge as requested. Honor instructions to leave work uncommitted.
6. foreman archive doctor-help
   After merge and a clean worktree, archive records and free the name. To retain unfinished work, use foreman archive doctor-help --keep-worktree.

Rules:
- Never bypass a guard or hook refusal, or edit Codex trust or auth. Ask the user.
- Never commit delegated work without reviewing the diff and running the repo's gate yourself.
- Run waits in the background. Stop every wait or loop you started once its run is archived or replaced.
- Defer questions that need a person; answer the same id later. Progress belongs in the hand-off, not ask_orchestrator calls that pause the delegate.

Read foreman <command> --help for that command's arguments, flags, defaults, states, exit codes and examples.
Topics:
  foreman guide contract        Fillable implementation contract
  foreman guide contract tests  Fillable test-author contract
  foreman guide supervise       Questions, continuations, waits and parallel runs
  foreman guide review          Review, refactor, gate, commit and archive
  foreman guide recover         Failures, budgets, lost supervision and upgrades`;

const superviseText = `Handle attention

Run foreman status doctor-help for the current state. Follow the printed next: command after each result.
Answer a pending question with foreman answer doctor-help q1 "Decision" --wait; it resumes the held tool call.
If a person must decide, use foreman defer doctor-help q1 "Waiting for the owner" --wait immediately.
Deferral or question timeout releases the call so Codex can do independent work, avoid irreversible steps on the decision and report it under Open.

Send the same answer command when the decision arrives, even after timeout, cancellation or supersession.
It includes the original question, steers a running turn or starts a follow-up on an inactive run. Answering again sends a correction.
If Codex refuses the late steer, answer waits for inactivity and starts the follow-up in the same call.
If another question is pending, answer that id first and include both decisions in its text.
During a budget hand-off, answers queue in acceptance order; answer --wait waits for the delivered answer's turn.
Queued answers block followup, archive, daemon shutdown and name/worktree reuse. After a daemon crash, inspect history and resend undelivered decisions; the queue is not rebuilt.

Change the task

Use foreman steer doctor-help "Include repo hook trust" --wait only on a running turn with no pending question.
Use foreman followup doctor-help "Fix the review findings and rerun the gate" --wait on an inactive run with a saved thread and existing worktree.
Explicit steer and followup supersede unanswered questions; their ids still accept late answers.
Use foreman interrupt doctor-help --wait to stop an active turn or cancel start preflight, then read status before reusing its worktree.
Answer, steer and followup take one message argument or --file, never both. Ask the user only for decisions the contract and repo cannot settle.

Wait and supervise peers

Run every --wait command and foreman wait --all as a background task so you remain available.
Mutation waits target the named run only. Explicit wait --all supervises the current repo and its linked worktrees.
Names are global within FOREMAN_HOME, including across repos. Parallel tasks need separate worktrees and independent scopes.
Every wait outcome exits 0: events needs attention, timeout means continue the printed command, none means the group has no active runs or unseen attention.
Use the opaque --after cursor in next: commands to avoid repeated attention; an explicit wait timeout is preserved by wait continuations.
An attention timeout bounds waiting only, after setup and mutation delivery. Stop old waits and polling loops once a run is archived or replaced.
Start without waiting returns Started; with waiting it returns Waited with start metadata.
Other mutations normally return Accepted with a cursor (answers include delivery), or Waited with waiting. Cancelling start preflight returns Ok without a cursor or wait.
Deferred questions remain in digests until answered or superseded. A done outcome means the turn ended, not that review passed.`;

const reviewText = `Review and land

1. Run foreman result doctor-help and read the hand-off. It names the turn; an older hand-off may be the latest available if the new turn wrote none.
2. In the returned worktree, inspect git diff and git status. Read new files too. Compare every changed path with the contract and the digest's outside May change list.
3. Focus on Decisions, disputed independent-review findings and Look closer at. The bundled contract asks for one independent review in a fresh Codex process.
   If implementation or that review is missing, send a follow-up contract with foreman followup doctor-help --file /tmp/doctor-help-followup.md --wait. Do not dispatch a second reviewer yourself.
4. Refactor with your own editing tools so repo hooks see the changes. Match the repo's idioms; remove unnecessary abstractions. Undo only the delegate's out-of-scope edits and preserve others' work.
5. Run the full repo gate yourself in that worktree. Inspect the revised diff, then commit using the repo convention and merge as requested. Honor instructions to leave work uncommitted; the CLI never commits or merges.
6. After merge and a clean worktree, run foreman archive doctor-help. It preserves records and frees the name.

Managed cleanup refuses dirty or untracked files, an unexpected branch, or new commits not merged into the source ref.
Use foreman archive doctor-help --keep-worktree to archive records while retaining unfinished work and its branch.
The CLI never removes a passed prepared worktree or branch; their cleanup belongs to the orchestrator.
Read orphan lines in foreman status or foreman doctor after a crash or retained archive. Inspect these worktrees before removing anything.

Scope is a review aid, not a write restriction. Contracts need a line beginning - May change: with backticked repo-relative paths.
A trailing slash covers a directory prefix; * matches within one segment, ** across directories, and literal paths also match suffixes.
Follow-ups retain the original contract's scope. If scope expands, prepare a new run and inspect the existing diff explicitly.`;

const recoverText = `Recover a run

Before retrying, run foreman status doctor-help, foreman result doctor-help and foreman events doctor-help, then inspect its worktree.
Use foreman events doctor-help --verbose for protocol chatter and token usage; JSON always includes every event in the selected page.
The digest names the run directory. Read its questions, events and turn hand-offs, plus FOREMAN_HOME/logs/daemon.jsonl and logs/app-server.log (default home: ~/.foreman).
Question and event storage is format 2; older binaries refuse those records. Preserve unreadable records and use a compatible version.

Failed and interrupted runs retain edits. If the approach is sound, send a short follow-up contract:
  foreman followup doctor-help --file /tmp/doctor-help-retry.md --wait
An inactive run needs a saved thread and existing worktree to continue. Without them, inspect and preserve the diff, then start a new run with a new name.
A transient: hint suggests continuing; usage-limit: needs plan capacity. After the same failure twice, stop and ask instead of retrying indefinitely.
Budget expiry interrupts work and requests a read-only hand-off with its own ten-minute budget. The run ends interrupted; a later follow-up restores its configured sandbox.
Do not assume a hand-off exists if Codex or supervision failed.

Lost means supervision ended. Inspect processes and logs before resuming to prevent two writers.
Unknown means execution is unconfirmed and ownership remains reserved. Do not start another writer in that worktree; read status and the recovery diagnostics.
Read resume warnings: dynamic question delivery on resumed threads depends on Codex retaining the tool. Do not promise automatic recovery.
After a daemon crash, inspect question history and resend queued decisions that were not delivered; the in-memory queue is not restored.

Upgrade safely

Update using your install method, then run foreman skill install to refresh the entry point (use its help if an edited copy is refused).
For a source install on macOS, copy the new binary to a new file in the install directory and rename it over the old one; overwriting the existing inode can cause exit 137.
Stop polling loops using older executables: they can replace an idle new daemon with their old build.
The next run command replaces an idle outdated daemon automatically. A busy daemon stays until its runs finish; a later call retries replacement.
Managed starts and defer are refused while it is outdated and busy. Only questions it still reports pending can be answered; late answers and corrections need the new daemon.
Finish those runs first. Use foreman daemon stop to stop an idle daemon without starting another; no running daemon is already success.
Run foreman doctor to compare builds without starting or replacing the daemon. Never work around trust, auth or hook refusals; ask the user.`;

export const guideTopics = {
  core: coreText,
  contract: contractText,
  "contract tests": contractTestsText,
  supervise: superviseText,
  review: reviewText,
  recover: recoverText,
};
