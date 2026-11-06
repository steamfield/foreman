---
name: forman
description: Delegate coding work to Codex through forman, supervise its questions and progress, then review, refactor, check and commit the work yourself. Use when the user asks for Codex or delegation, or for substantial implementation, test authoring or mechanical refactors with a clear contract, including independent tasks that can run in parallel.
---

# Delegating through forman

Claude prepares the worktree and contract. Codex implements, runs the checks and gets one
independent review in a fresh Codex process. Claude reviews the hand-off and diff, refactors,
runs the gate, commits and merges, then cleans up. Changes stay uncommitted until Claude's pass.

With `--write`, Codex runs unsandboxed with your environment and Codex configuration. It can
install packages, use the network and run tests. Read-only is the default; even test authoring
usually needs `--write` because runners write caches. Claude subagents use Claude's Agent tool.

## Read the repo's guidance

Read `AGENTS.md`, `CLAUDE.md` and `.claude/delegate.md` when present. The repo overlay wins on
worktree location, install command, gate, templates and constraints. Carry those requirements
into the contract. Translate any older runner settings into supported forman options; check
`forman --help` and `forman start --help` rather than forwarding old environment variables.

Delegate when writing a contract costs less than doing the work: implementation against a
written design, tests for existing behaviour, or a mechanical refactor. Give a feature the
directory scope its design needs. Keep design decisions, shared interfaces and agent harness
changes with Claude unless the user asks to delegate them. Finish small edits yourself.

## One-time repo setup

Have `forman` and a signed-in Codex CLI on `PATH` (use `codex login` if needed). The repo needs
a commit. In its main checkout, open `codex` and trust the project if prompted. If it has
`.codex/hooks.json`, use Codex's `/hooks`, inspect the project hooks and approve them. Exit
Codex and run:

```sh
forman doctor
```

Read the output even when the exit code is 0. Check the Codex executable, version, protocol
match and login. Each project hook should be `trusted` or `managed`, followed by
`forman start will accept runs here (hook trust).` Without project hooks, `no repo hooks apply`
is expected. An unavailable probe or hook state `unknown` needs attention before starting.
Doctor reports the running daemon's build and whether it matches this CLI; an old daemon
without a build reports unknown. It never starts or replaces a daemon or starts a Codex turn;
its hook check does not validate a worktree's
dependencies. Set `CODEX_BIN` to the real executable if a version-manager shim fails.

Worktrees inside the main checkout inherit its approved hooks. Changes to the main checkout's
hook definitions need approval again. Hook edits only in a delegated branch take effect after
they reach the main checkout. Don't edit `~/.codex` config, hooks, trust or auth to get past a
refusal. Codex's own runtime session and log writes there are fine.

## Prepare the work

1. Create one linked worktree per delegate inside the main checkout, normally beneath
   `.claude/worktrees/`. Use an unused branch and directory, and name the base explicitly.
   Run the orchestration commands from the main checkout, addressing worktrees by path:

   ```sh
   git check-ignore .claude/worktrees/probe
   git worktree add -b delegate/<name> .claude/worktrees/<name> <base-branch>
   ```

   If that directory is not ignored, use the file-writing tool to add `.claude/worktrees/`
   to the common git directory's `info/exclude` before creating it. Find that directory with
   `git rev-parse --git-common-dir`. In the new worktree, run the repo's install command.
   For a `package.json` project, forman checks for `node_modules/` or `.pnp.cjs`. Install the
   actual dependencies; use `--skip-deps-check` only when the repo's setup justifies it.

2. Copy [contract.md](contract.md) to a scratch file outside the worktree and fill the task
   placeholders; the delegate fills `{REVIEW DIR}` after creating its review directory.
   Use [contract-tests.md](contract-tests.md) for a test author working ahead of
   an implementer. Name the applicable rule and skill files: Codex reads `AGENTS.md`, but does
   not automatically load Claude's rules, `CLAUDE.md` or this conversation. Include wiring
   files in scope when the task needs them.

   The scope line must start with `- May change:` and list actual repo-relative paths in
   backticks, with a trailing `/` for a directory. For example:

   ```markdown
   - May change: `src/doctor/`, `tests/doctor.test.ts`.
   - Must not change: `src/cli.ts`.
   ```

   Prose such as "the files listed above" and glob patterns do not declare scope. Forman
   compares dirty paths to these entries; it does not enforce the boundary for you.

3. Choose a visible Codex model and fill `{REVIEW MODEL}` with its literal name. Use that same
   name with `--model` below, then confirm it against the model in the digest's `run:` header.
   For the usual default, read Codex's `models_cache.json` and choose the newest visible
   `gpt-*-sol`; forman falls back to `gpt-6.1-sol` if its cache lookup fails. No old runner
   variable supplies the review model. If the reported name differs, send a correction before
   the delegate reviews. Fill the base branch and absolute contract path too.

## Start and supervise

```sh
forman start <name> --worktree .claude/worktrees/<name> --contract <contract-path> --write --model <model> --wait
```

Run `start --wait` with Claude Code's Bash `run_in_background: true`, so Claude remains
available. It prints the start lines followed by the next question or terminal outcome and
hand-off. A delegation needing no answer takes one call. Without `--wait`, start returns
after starting the turn and prints `next: forman wait <name>`; run that command in the
background. For several runs use `forman wait --all`, also in the background. Run up to five delegates at
once, each with its own worktree and independent scope. Names are global within forman's data
directory; choose distinct names across repos. `--all` covers the current repo and its linked
worktrees, not every repo.

Defaults are high effort, priority tier, a one-hour turn budget and a 15-minute question
timeout. Override with `start`'s `--effort`, `--tier`, `--budget` and `--question-timeout` when
the contract warrants it. Durations are whole numbers such as `90s` or `45m`.

When wait returns, read its outcome and each digest. All wait outcomes exit 0:

| Outcome | Action |
| --- | --- |
| `events` | Handle each `question`, `done`, `failed`, `interrupted` or `lost` item. |
| `timeout` | Run the printed next wait command; the run may still be working. |
| `none` | No active runs or unseen attention remain for `--all`; stop waiting until more work starts. |

After handling attention, run the final `next:` command as another background task. It carries
the cursor (`--after`) that prevents repeated attention and preserves any explicit `--timeout`.
Don't rebuild it from memory. `start`, `answer`, `followup` and `steer` accept `--wait` with
the same 60-minute default as standalone wait. For a foreground call, use `--timeout 9m`
to stay below Claude Code's foreground limit.

These commands apply at different states:

```sh
forman answer <name> <question-id> "The decision the delegate needs." --wait
forman steer <name> "A correction to the active task." --wait
forman followup <name> --file <followup-contract-path> --wait
forman result <name>
```

Answer the printed question id to resume its held tool call. Use `steer` only on an active turn
with no pending question. Use `followup` on an inactive run to continue its Codex thread, with
`--budget <duration>` or `--effort <effort>` if needed. Answer, steer and followup accept either
one text argument or `--file <path>`, never both. Ask the user only for a decision you cannot
make from the contract and repo. Delegates use `ask_orchestrator` for blockers or consequential
decisions; progress, findings and corrections belong in the hand-off.

Run these `--wait` calls in the background too. One question takes exactly two calls:
`start --wait`, then `answer --wait`. Without `--wait`, answer, steer and followup print `ok`
and a `next:` wait command with the run's cursor at acceptance. Use that command to hear
the next outcome without replaying earlier attention. With `--json`, the acknowledgement is
`Accepted` with `cursor` and `next`; `--wait` returns `Waited`. Start's combined JSON result
also carries `started: {name, runDir}` in the same value.

## Review and land the work

`done` means the turn ended. Read the included hand-off, or reread it with `forman result
<name>`, then inspect the diff and new files. Focus on decisions, disputed review findings and
"Look closer at". Check every changed path, including the digest's `outside May change` list.
The contract requires one independent review in a fresh Codex process before hand-off. A
missing review or implementation work still needed goes back as a follow-up contract; Claude
does not dispatch a second reviewer. Start a narrower fresh run only if the approach went wrong.

Keep follow-ups inside the original scope: the digest checks the original contract's May change
entries. If scope must expand, prepare a new run and contract and inspect the existing diff
explicitly; a follow-up file does not replace those entries.

Refactor with Claude's editing tools so the repo's hooks see the changes. Match surrounding
idiom, use existing helpers and remove unnecessary abstractions. Undo only the delegate's
out-of-scope edits; preserve other people's work. Run the full repo gate in the worktree after
the refactor, commit there using the repo's convention, then merge as the task requires.
Forman does not commit or merge. Honour any user instruction to leave work uncommitted.

Once merged, remove the worktree and confirm its branch is an ancestor of the landing branch
before deleting it. Run these as separate commands, and delete only if the ancestor check
succeeds:

```sh
git worktree remove .claude/worktrees/<name>
git merge-base --is-ancestor delegate/<name> <landing-branch>
git branch -D delegate/<name>
forman archive <name>
```

Archive requires an inactive run, preserves its records and prints the archive path. It frees
the name for reuse. For abandoned work, inspect and preserve anything useful before removing
it. Remove only worktrees you created. Cleanup belongs to Claude, never the delegate.

## Recover a failed or lost run

Read `forman status <name>`, `forman result <name>`, `forman events <name>` and
`git -C <worktree> status` before deciding. The digest gives the run directory; its records,
`events.jsonl`, raw Codex traffic and `turns/<n>.md` hand-offs help explain partial work.
Daemon diagnostics are under the data directory's `logs/daemon.jsonl` and `logs/app-server.log`.

An interrupted or failed run leaves its edits in place. If it is on track, send a short
follow-up contract, with a larger `--budget` if the turn budget expired. A `transient:` hint
suggests a short "continue" follow-up; a `usage-limit:` hint needs available plan capacity.
If the same failure repeats twice, stop and ask rather than retrying indefinitely.

`lost` means supervision was lost, not that the edits disappeared. Check the processes and
logs before resuming so two writers cannot share a worktree. An inactive run with a saved
thread and an existing worktree can accept a follow-up; without either, prepare a new run.
Read resume warnings: questions may not reach Claude on a resumed thread. Don't promise
automatic recovery or a final hand-off. For a supervised active turn, `forman interrupt
<name>` requests interruption; read its result before reusing the worktree.

## Upgrade forman

After updating the source, run `bun install` and `bun run build`, then replace your installed
binary with `dist/forman`. Run `forman daemon stop` so the next run command starts the new
build. Stop refuses while runs are active and names them; finish them or use `forman interrupt
<name>` first, then retry stop. With no daemon, stop succeeds without starting one. Run
`forman doctor` after the upgrade and read its probes.

## Example: clarify doctor help

In this repo's main checkout, after setup, use an unused branch and directory:

```sh
git worktree add -b delegate/doctor-help .claude/worktrees/doctor-help <base-branch>
```

Run `bun install` in that worktree. Copy `contract.md` to a scratch file, with the goal
"Clarify that doctor reports repo hook trust", this scope, checks `bun run lint` and
`bun run typecheck`, and the filled review instructions:

```markdown
- May change: `src/commands/doctor.ts`.
```

For example, if the selected visible model is `gpt-6.1-sol`, set
`{REVIEW MODEL}` to that literal name and start:

```sh
forman start doctor-help --worktree .claude/worktrees/doctor-help --contract <filled-contract-path> --write --model gpt-6.1-sol --wait
```

Run it in the background, confirm the model in its digest header and follow each `next:`
command. Read the hand-off and diff, refactor, run `bun run check`, commit and merge. Remove
the worktree, verify and delete the merged branch, then `forman archive doctor-help`.
