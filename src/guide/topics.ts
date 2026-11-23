/**
 * The text `foreman guide` prints: the core workflow and one topic per situation. Topics that
 * describe provider behavior state the difference in one line where it applies.
 */
import { contractText } from "./contract";
import { contractTestsText } from "./contract-tests";

export const coreText = `The foreman CLI delegates coding tasks to Codex or agy (Antigravity's Gemini agent) in isolated git worktrees and supervises them through a local daemon.
You write the contract, handle decisions, then review and run the repo's gate before committing or merging.

The model you pass to start --model picks the provider; every other command works the same on both. Pick a model from foreman models, which lists every id, effort and default, and use the same literal model for start and the contract's review command (replace gpt-6.1-sol in the example below if needed).
  provider  models                           sign in                   default model and effort
  codex     GPT models in Codex's catalog    codex login               newest gpt-*-sol when --model is omitted; high
  agy       Gemini and the others agy lists  run agy once and sign in  none, name one; high, with low to xhigh by model
Codex enforces read-only runs with a sandbox. On agy, read-only refuses agy's edit tools but not shell commands, so use Codex for read-only work that must not write.

Before delegating:
- Read AGENTS.md, CLAUDE.md and .claude/delegate.md when present. Keep unresolved design decisions with the orchestrator; do small edits yourself.
- Have the foreman CLI and the provider's CLI on PATH and signed in, and a repo with a commit.
- On first Codex use, open Codex in the main checkout, trust the project if asked and approve its project hooks in /hooks. agy runs a committed .agents/hooks.json without a trust step, and agy starts are refused in a repo whose only hooks are .codex/hooks.json. Run foreman doctor and read every probe even on exit 0.

The delegation loop (replace doctor-help and the install/gate commands for your repo):
1. foreman guide contract > /tmp/doctor-help-contract.md
   Fill every task placeholder outside the worktree, including the base branch, absolute contract path, checks and review model. Use foreman guide contract tests for a test author, and add agy to either topic for an agy run.
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
- Never bypass a guard or hook refusal, or edit Codex or agy trust or auth. Ask the user.
- Never commit delegated work without reviewing the diff and running the repo's gate yourself.
- Run waits in the background. Stop every wait or loop you started once its run is archived or replaced.
- Defer questions that need a person; answer the same id later. Progress belongs in the hand-off, not ask_orchestrator calls that pause the delegate.

Read foreman <command> --help for that command's arguments, flags, defaults, states, exit codes and examples.
Topics:
  foreman guide contract [agy]        Fillable implementation contract, for Codex or agy
  foreman guide contract tests [agy]  Fillable test-author contract, for Codex or agy
  foreman guide supervise             Questions, continuations, waits and parallel runs
  foreman guide review                Review, refactor, gate, commit and archive
  foreman guide recover               Failures, budgets, lost supervision and upgrades`;

const superviseText = `Handle attention

Run foreman status doctor-help for the current state. Follow the printed next: command after each result.
Answer a pending question with foreman answer doctor-help q1 "Decision" --wait; it resumes the held tool call.
If a person must decide, use foreman defer doctor-help q1 "Waiting for the owner" --wait immediately.
Deferral or question timeout releases the call so the delegate can do independent work, avoid irreversible steps on the decision and report it under Open.
On agy, questions arrive through foreman's MCP tool, which agy holds for a limited time: an agy run's question timeout is capped below that hold, and its warnings name the cap.

Send the same answer command when the decision arrives, even after timeout, cancellation or supersession.
It includes the original question, steers a running turn or starts a follow-up on an inactive run. Answering again sends a correction.
If the delegate refuses the late steer, answer waits for inactivity and starts the follow-up in the same call.
If another question is pending, answer that id first and include both decisions in its text.
During a budget hand-off, answers queue in acceptance order; answer --wait waits for the delivered answer's turn.
Queued answers block followup, archive, daemon shutdown and name/worktree reuse. After a daemon crash, inspect history and resend undelivered decisions; the queue is not rebuilt.

Change the task

Use foreman steer doctor-help "Include repo hook trust" --wait only on a running turn with no pending question.
On agy a steer joins the running turn as a second prompt; once the turn has finished, agy refuses it (exit 8), so wait and send a followup. Only answer falls back to a follow-up on its own.
Use foreman followup doctor-help "Fix the review findings and rerun the gate" --wait on an inactive run with a saved thread and existing worktree.
Explicit steer and followup supersede unanswered questions; their ids still accept late answers.
Use foreman interrupt doctor-help --wait to stop an active turn or cancel start preflight, then read status before reusing its worktree.
Answer, steer and followup take one message argument or --file, never both. Ask the user only for decisions the contract and repo cannot settle.

Wait and supervise peers

Run every --wait command and foreman wait --all as a background task so you remain available.
Use foreman events <name> --follow in a terminal to watch a run live; agents keep using wait.
Follow connects passively: it never starts, replaces or keeps a daemon alive. Without a compatible daemon it prints saved events and one stderr note, then exits 0; foreman status <name> starts supervision.
Mutation waits target the named run only. Explicit wait --all supervises the current repo and its linked worktrees.
foreman wait a b returns as soon as any named run needs attention or ends a turn; use it instead of status polling loops or sleeps.
foreman status --all lists runs across every repo; keep using wait for outcomes rather than polling.
Humans can open foreman monitor for the live terminal list; agents use status --all.
Do not pipe wait output through head, grep or ||: the outcome line and next: are at its end, and a pipe hides the exit status.
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
3. Focus on Decisions, disputed independent-review findings and Look closer at. The bundled contract asks for one independent review in a fresh process of the run's provider.
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
The digest names the run directory. Read its questions, events and turn hand-offs, plus FOREMAN_HOME/logs/daemon.jsonl and logs/app-server.log, or logs/agy-acp.log and logs/agy-stderr.log for agy (default home: ~/.foreman).
Question and event storage is format 2, and agy run records are format 3; older binaries refuse those records. Preserve unreadable records and use a compatible version.

Failed and interrupted runs retain edits. If the approach is sound, send a short follow-up contract:
  foreman followup doctor-help --file /tmp/doctor-help-retry.md --wait
An inactive run needs a saved thread and existing worktree to continue. Without them, inspect and preserve the diff, then start a new run with a new name.
A transient: hint suggests continuing; usage-limit: needs plan capacity. After the same failure twice, stop and ask instead of retrying indefinitely.
Budget expiry interrupts work and requests a read-only hand-off with its own ten-minute budget. The run ends interrupted; a later follow-up restores its configured sandbox.
On agy the hand-off turn refuses edits and allows shell commands, as a read-only agy run does.
A read-only agy run fails when an agy edit is refused (agy ends the turn there) or a shell command changed files; follow up with narrower instructions, or use a write run or Codex.
Do not assume a hand-off exists if the provider or supervision failed.

Lost means supervision ended. Inspect processes and logs before resuming to prevent two writers.
Unknown means execution is unconfirmed and ownership remains reserved. Do not start another writer in that worktree; read status and the recovery diagnostics.
Read resume warnings: dynamic question delivery on resumed Codex threads depends on Codex retaining the tool. agy resumes its session with the question tool and the run's model. Do not promise automatic recovery.
After a daemon crash, inspect question history and resend queued decisions that were not delivered; the in-memory queue is not restored.

Upgrade safely

Update using your install method, then run foreman skill install to refresh the entry point (use its help if an edited copy is refused).
For a source install on macOS, copy the new binary to a new file in the install directory and rename it over the old one; overwriting the existing inode can cause exit 137.
Stop polling loops using older executables: they can replace an idle new daemon with their old build.
The next run command replaces an idle outdated daemon automatically. A busy daemon stays until its runs finish; a later call retries replacement.
Managed starts and defer are refused while it is outdated and busy. Only questions it still reports pending can be answered; late answers and corrections need the new daemon.
Finish those runs first. Use foreman daemon stop to stop an idle daemon without starting another; no running daemon is already success.
Run foreman doctor to compare builds without starting or replacing the daemon. Never work around trust, auth or hook refusals; ask the user.`;

/** Every guide topic by the words that select it; contract topics take an optional provider. */
export const guideTopics = {
  core: coreText,
  contract: contractText("codex"),
  "contract agy": contractText("agy"),
  "contract tests": contractTestsText("codex"),
  "contract tests agy": contractTestsText("agy"),
  supervise: superviseText,
  review: reviewText,
  recover: recoverText,
};
