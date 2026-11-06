---
name: forman
description: Delegate coding work to Codex through forman, supervise its questions and progress, then review, refactor, check and commit the work yourself. Use when the user asks for Codex or delegation, or for substantial implementation, test authoring or mechanical refactors with a clear contract, including independent tasks that can run in parallel.
---

# Delegate through forman

Write a contract and start Codex in an isolated worktree. Codex implements, runs the contract's checks and gets its independent review. Claude reviews the hand-off and diff, refactors and runs the gate before committing or merging. Honor instructions to leave work uncommitted.

## Read the repo and check setup

Read `AGENTS.md`, `CLAUDE.md` and `.claude/delegate.md` when present. Carry the repo's rules, install command, checks and constraints into the contract. Codex reads AGENTS.md but does not automatically load Claude's rules or this conversation. Name the applicable rule and skill files explicitly.

Delegate implementation against a written design, tests for existing behavior or a mechanical refactor when a contract costs less than doing the work. Keep shared interfaces and unresolved design decisions with Claude unless the user asks to delegate them. Do small edits yourself.

Have forman and a signed-in Codex CLI on PATH. The repo needs a commit. For first use, open `codex` in the main checkout and trust the project if prompted. If `.codex/hooks.json` exists, run `/hooks`, inspect and approve the project hooks. Exit Codex and check:

```sh
forman doctor
```

Read every probe even when exit is 0: executable, login, protocol match and hook trust. Project hooks must be trusted or managed. Without repo hooks, `no repo hooks apply` is expected. Doctor never starts or replaces the daemon or starts a turn. Set CODEX_BIN to the actual executable if a version-manager shim fails.

Linked worktrees inside the main checkout inherit its approved hooks. Reapprove changed main-checkout definitions. Hook edits in a delegated branch take effect after reaching the main checkout. Do not edit Codex trust, auth or hook settings to bypass a refusal.

## Prepare the contract

Choose an unused run name, `forman/<name>` branch and `.claude/worktrees/<name>` directory. Names are global within FORMAN_HOME, including across repos. Determine the install command. A package.json project needs node_modules or .pnp.cjs; use `--skip-deps-check` only when the setup warrants it.

Copy [contract.md](contract.md) to a scratch file outside the worktree and fill its placeholders, including the base branch and absolute contract path. The delegate fills the review directory. Use [contract-tests.md](contract-tests.md) for tests ahead of an implementer. Include wiring files in scope when needed.

Scope must begin with `- May change:` and use backticked repo-relative paths:

```markdown
- May change: `src/doctor/`, `tests/*doctor*.test.ts`.
- Must not change: `src/cli.ts`.
```

A trailing slash covers a directory prefix, `*` matches within a segment and `**` across directories. Literal paths also match suffixes. Prose such as "the files above" does not declare scope. The digest compares dirty Git paths to those entries; it does not enforce them. Follow-ups keep the original contract's scope. If the scope must expand, prepare a new run and inspect the existing diff explicitly.

Choose a visible Codex model and fill the review model with its literal name. For the usual default, read Codex's models_cache.json and choose the newest visible gpt-*-sol; forman falls back to gpt-6.1-sol. Use the same model on start and confirm the digest header before the delegate reviews. Do not forward settings from older runners; consult `forman start --help`.

## Start the delegate

For example, after filling `/tmp/doctor-help-contract.md` for this repo, choosing gpt-6.1-sol and checking that doctor-help is unused:

```sh
forman start doctor-help --new-worktree --setup "bun install" --contract /tmp/doctor-help-contract.md --write --model gpt-6.1-sol --wait
```

Substitute the repo's install command, filled contract path and chosen model for other tasks. Use Claude Code's Bash `run_in_background: true` so Claude remains available. Start with --wait prints nothing until attention arrives, then returns the run directory, worktree and branch together with the digest and available hand-off.

forman creates the worktree beneath the main checkout, based on the caller's HEAD or `--from`. Setup runs through `/bin/sh -c` with Codex's filtered environment before validation or any Codex request. It defaults to a 10-minute limit; an explicit `--budget` sets the setup limit too, separately from the turn budget. Refusals roll back owned resources when safe; an unconfirmed turn start or remaining work retains the worktree and reports its path. Inspect that refusal before retrying.

For an already prepared linked worktree inside the main checkout, use `--worktree` instead of `--new-worktree`. Install dependencies first. `--setup` and `--from` require `--new-worktree`. forman never removes a passed worktree or branch.

Read-only is the default. `--write` gives full host access with no approval prompts; it permits network, installs and tests using the filtered inherited environment and Codex configuration. Even test authoring usually needs write access because runners write caches.

Defaults are high effort, priority tier, a 60-minute turn budget and a 15-minute question timeout. Set `--effort`, `--tier`, `--budget` or `--question-timeout` when the contract calls for it. Durations are nonnegative whole numbers with ms, s, m or h, such as 90s or 45m.

## Handle attention

Read each outcome and digest. Every wait outcome exits 0:

| Outcome | Action |
| --- | --- |
| events | Handle each question, done, failed, interrupted or lost item |
| timeout | Run the printed next command; work may still be active |
| none | For wait --all, no active runs or unseen attention remain in the group |

Use printed `next:` commands. Question outcomes suggest answer, with defer as an alternative while pending. Replace the answer placeholder with the decision. Ordinary wait continuations carry an opaque `--after` cursor and preserve an explicit timeout. The executable may be an absolute path; FORMAN_HOME is prefixed only for a nondefault home. Keep those details intact.

For doctor-help, these commands are alternatives at the corresponding state; use the actual question id:

```sh
forman answer doctor-help q1 "Keep the description to one sentence." --wait
forman defer doctor-help q1 "Waiting for a person to decide." --wait
forman steer doctor-help "Include repo hook trust in the description." --wait
forman followup doctor-help "Check the help output again and report the result." --wait
forman interrupt doctor-help --wait
```

Answer pending questions to resume their held tool calls. If the decision needs a person, defer immediately so the delegate can continue independent work. Timeout also defers: Codex is told to avoid irreversible steps on that decision, use a safe reversible default within the contract if available, and list the question and its handling under Open. Defer requires a pending question. Deferred questions remain in status and wait digests until answered or superseded.

Send the same answer command when the decision arrives late, including after timeout or interruption. It carries the original question text and steers a running turn or starts a follow-up on an inactive run. A refused late steer waits for the turn to finish and falls back to a follow-up in the same command. Answering again sends a correction. If another question is pending, answer that id first and include both decisions in its text.

During a budget hand-off, answer returns accepted with queued delivery. Further answers and corrections join behind it. Queued answers prevent follow-up turns, archiving, daemon shutdown and reuse of the run name or worktree until delivery finishes. `answer --wait` waits for the delivered answer's turn, not the earlier hand-off. If the daemon crashes, inspect question history and resend undelivered decisions: the delivery queue is not rebuilt.

Use explicit steer only on a running turn with no pending question. Use followup on an inactive run to continue its saved thread, optionally changing its budget or persistent effort. Steer and followup supersede unanswered questions; those ids still accept late answers. Answer, steer and followup take one message argument or `--file`, never both. Ask the user only for a decision the contract and repo cannot settle. Delegate progress belongs in the hand-off; ask_orchestrator pauses the turn.

Run combined waits in the background too. Start, answer, defer, steer, followup and interrupt accept `--wait`, defaulting to 60 minutes. For a foreground call use a shorter wait, such as `--timeout 9m`; this bounds attention waiting, not earlier setup or mutation delivery. Without wait, accepted mutations normally print ok and a named-run wait command with the cursor captured before dispatch. Only continuations from a completed wait preserve an explicit timeout. Combined waits and next commands target the named run only, even when peers are active. To supervise the current repo group, including its linked worktrees, explicitly run:

```sh
forman wait --all
```

Use separate worktrees and independent scopes for parallel delegations. A quiet delegation takes one start --wait call; a single in-time question takes a second answer --wait call. JSON start returns Started, or Waited with started metadata when waiting. Other mutations normally return Accepted, or Waited with --wait. Interrupting start preflight returns Ok without a cursor or continuation, even with --wait; read status before deciding what to start next.

## Review and land

Done means the turn ended. Read its hand-off, or reread it:

```sh
forman result doctor-help
git -C .claude/worktrees/doctor-help diff
git -C .claude/worktrees/doctor-help status --short
```

Inspect new files, every changed path and the digest's outside May change list. Focus on decisions, disputed review findings and Look closer at. The contract template requires one independent review in a fresh Codex process. Missing review or unfinished implementation goes back in a follow-up contract; Claude does not dispatch a second reviewer.

Refactor with Claude's editing tools so repo hooks see the changes. Match surrounding idioms and remove unnecessary abstractions. Undo only the delegate's out-of-scope edits; preserve others' work. Run the full repo gate in the worktree, commit using its convention, then merge as requested. forman does not commit or merge. Honor the user's instructions about leaving work uncommitted.

Once merged and clean, archive:

```sh
forman archive doctor-help
```

Managed cleanup refuses dirty/untracked files or new commits not merged into the source ref. To retain unfinished work, use `forman archive doctor-help --keep-worktree`. Both forms preserve records and free the name. Inspect orphan lines in status or doctor after a crash or retained archive. For a passed worktree, cleanup is Claude's job, never the delegate's.

## Recover and upgrade

Read status, result and events before retrying. For this example:

```sh
forman status doctor-help
forman events doctor-help
forman events doctor-help --verbose
```

Default text events omit protocol chatter and token usage; verbose includes them, and JSON always includes the complete selected page. The digest names the run directory. Its event/question history and turn hand-offs help explain partial work. Daemon logs live under FORMAN_HOME/logs, defaulting to ~/.forman/logs. Question and event storage uses format 2; older binaries refuse those runs.

Failed and interrupted runs retain edits. If the approach is sound, send a short follow-up contract. A transient hint suggests continuing; a usage-limit hint needs plan capacity. After the same failure twice, stop and ask instead of retrying indefinitely. Budget expiry interrupts work and requests a read-only hand-off with its own 10-minute budget; a later follow-up restores the configured sandbox.

Lost means supervision ended. Inspect processes and logs before resuming to prevent two writers. An inactive run needs a saved thread and an existing worktree to continue. Unknown means execution is unconfirmed and ownership remains reserved. Read resume warnings: dynamic question delivery on resumed threads depends on Codex retaining the tool. Do not promise automatic recovery or a final hand-off.

After installing an upgrade, the next run command replaces an idle outdated daemon automatically. A busy daemon stays in service until its runs finish; a later call retries replacement. Stop polling loops using an older executable, since they can replace an idle new daemon with their old build again. Managed starts and defer are refused while it is outdated and busy. Only questions it still reports pending can be answered; late answers and corrections need the new daemon. Finish its runs first. Explicit `forman daemon stop` stops an idle daemon without starting another and succeeds when none is running. Doctor reports the build comparison without replacing it.
