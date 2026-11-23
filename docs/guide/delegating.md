# Delegating a task

Write a contract, start a run in its own worktree, wait in the background, answer questions, steer a turn, then review and archive the result.

This page follows one run, `doctor-help`, through the loop. Claude Code runs these commands when it uses the foreman skill; the same commands work by hand. Everything here applies to both Codex and agy unless a section says otherwise. `foreman guide` prints the installed version's own walkthrough, and `foreman <command> --help` has every flag.

## Write a contract

A contract is a Markdown file describing the task. Start from a template:

```sh
foreman guide contract > /tmp/doctor-help.md          # Codex implementation
foreman guide contract agy > /tmp/doctor-help.md      # agy implementation
foreman guide contract tests > /tmp/doctor-help.md    # a test author (add agy for agy)
```

Keep the file outside the worktree and fill every placeholder: the goal, files to read first, the interface, acceptance checks, and the review model. The templates ask the delegate for one independent self-review in a fresh process of the same provider (`codex exec` or `agy -p`) and end with a fixed hand-off format: summary, files, decisions, checks, review, things to look closer at, and open questions.

### Scope

Declare scope with a line beginning `- May change:` and backticked repo-relative paths:

```markdown
- May change: `src/commands/doctor.ts`, `tests/doctor/`
- Must not change: `src/schemas/`
```

| Pattern | Matches |
| --- | --- |
| `tests/doctor/` | Everything under that directory |
| `src/*.ts` | `.ts` files directly in `src/` (`*` stays within one path segment) |
| `src/**/*.test.ts` | Test files at any depth |
| `doctor.ts` | That path, or any path ending in it |

Scope is a review aid, not a write restriction. The digest lists dirty paths outside it so you can check them; nothing stops the delegate writing there. Follow-ups keep the original contract's scope.

## Start a run

```sh
foreman start doctor-help --new-worktree --setup "bun install" \
  --contract /tmp/doctor-help.md --write --wait
```

This uses Codex's default model. Add `--model gemini-4-neon` (with the agy contract) to run it on agy, or name any model from `foreman models`.

Choose exactly one worktree mode:

| Flag | What it does |
| --- | --- |
| `--new-worktree` | Creates `.claude/worktrees/<name>` on branch `foreman/<name>` from your current `HEAD`, or from `--from <ref>`. foreman removes it on archive when it's clean. |
| `--worktree <path>` | Uses a linked worktree you prepared inside the main checkout. foreman never removes it or its branch. |

Other start flags:

| Flag | Default | Notes |
| --- | --- | --- |
| `--write` | Read-only | Full host access, commands and network, with no approval prompts. Without it, Codex runs in a read-only sandbox with network disabled; agy refuses its edit tools (see [providers](providers.md#where-the-providers-differ)). |
| `--model` | Codex default | Picks the provider. See [Providers and models](providers.md). |
| `--effort` | `high` | agy accepts only the efforts its model lists. |
| `--tier` | `priority` | Codex only. |
| `--setup <cmd>` | None | Runs in the new worktree before the delegate starts; limited to 10 minutes, or to `--budget` when you pass one. Requires `--new-worktree`. |
| `--budget` | `60m` | Time limit for each working turn. |
| `--question-timeout` | `15m` | Time before an unanswered question is deferred. Capped at 100 seconds on agy. |
| `--skip-deps-check` | Off | Skips the `node_modules/` or `.pnp.cjs` check for a prepared worktree. |
| `--wait`, `--timeout` | Off, `60m` | Wait for this run's attention after the start is accepted. |

Run names are 1 to 64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit, and are global across every repo using the same `FOREMAN_HOME`. Starting a name that belongs to an inactive run archives the old records once preflight passes. If start fails, it rolls back only resources it created and left unchanged, and prints the path and branch of anything it kept.

Durations everywhere are whole numbers with `ms`, `s`, `m` or `h`: `90s`, `45m`, `2h`.

## Wait for attention

`--wait` on a mutation, or `foreman wait`, blocks until a run needs you. Run it in the background so the orchestrator stays free.

```sh
foreman wait doctor-help                 # one run
foreman wait doctor-help parser          # returns when either needs attention
foreman wait --all                       # every run in this repo and its linked worktrees
```

Every wait outcome exits 0 and ends with a `next:` command to run next. Follow it: it carries an opaque `--after` cursor so you don't see the same attention twice.

| Outcome | Meaning |
| --- | --- |
| `events` | A run needs attention: `question`, `done`, `failed`, `interrupted` or `lost`, each with a digest |
| `timeout` | Nothing new before the deadline; run the printed command to keep waiting |
| `none` | `--all` found no active runs and no unseen attention in the group |

`done` means the turn ended, not that the work passed review. Don't pipe wait through `head` or `grep`: the outcome and `next:` line are at the end, and a pipe hides the exit status. To check progress without waiting, use `foreman status doctor-help`; to see every run on the machine, `foreman status --all`.

## Handle questions

The delegate asks through an `ask_orchestrator` tool and holds until it gets an answer. The run shows `waiting` and the question gets an id: `q1`, `q2` and so on.

```sh
foreman answer doctor-help q1 "Keep the existing public API" --wait
foreman answer doctor-help q2 --file /tmp/owner-decision.md
```

When a person has to decide, release the delegate right away:

```sh
foreman defer doctor-help q1 "Waiting for the owner" --wait
```

Deferral tells the delegate to continue with independent work, use only safe reversible defaults within the contract, avoid irreversible steps that depend on the decision, and report it under Open. When the question timeout passes, foreman defers on its own. The question stays in the digest as unanswered.

Send `answer` on the same id when the decision arrives, even after deferral or timeout. foreman includes the original question and delivers it the best way the run's state allows:

| Run state | A late answer |
| --- | --- |
| `running` | Steers the current turn; if the delegate refuses the steer, foreman waits for the turn to end and starts a follow-up |
| `idle`, `failed`, `interrupted`, `lost` | Starts a follow-up turn (needs the saved session and the worktree) |
| Budget hand-off in progress | Queues and is delivered after the hand-off, in acceptance order |

Answering an id that was already answered sends a correction. If another question is pending, answer that one first and include both decisions in its text.

On agy, a held question ends after about 180 seconds, so agy runs defer at 100 seconds. A question agy drops before an answer is recorded as cancelled, and a later answer to it takes the late-answer path.

## Steer, follow up or interrupt

| Command | Use it when | Accepted states |
| --- | --- | --- |
| `foreman steer doctor-help "Mention hook trust" --wait` | The running turn is going the wrong way | `running`, with no pending question |
| `foreman followup doctor-help "Fix the review findings" --wait` | The turn is over and there's more to do | `idle`, `failed`, `interrupted`, `lost` |
| `foreman interrupt doctor-help --wait` | The turn should stop now | Active turns, and start preflight |

`steer`, `followup` and `answer` take one message argument or `--file`, never both. A steer or follow-up supersedes unanswered questions; their ids still accept late answers.

If a question is pending, `steer` refuses: answer the question and include the change. Codex can refuse a steer for a turn that isn't steerable; wait for the turn, then follow up. On agy a steer joins the running turn as a second prompt.

`followup` keeps the run's provider, model, contract scope and sandbox. `--budget` applies to that turn; `--effort` persists for later turns. It needs the saved session and the worktree, and refuses while answers are queued.

`interrupt` is a request, not proof the writer stopped. Read `foreman status` before reusing the worktree. Cancelling during start preflight returns without a cursor, even with `--wait`.

## Budgets

Each working turn has a budget, 60 minutes unless you pass `--budget` to `start` or `followup`. When it expires foreman:

1. interrupts the turn and cancels pending questions,
2. starts a read-only hand-off turn with its own 10-minute budget, asking the delegate to stop and report,
3. leaves the run `interrupted` once the hand-off ends.

A later follow-up restores the run's configured sandbox. On agy the hand-off turn refuses edits and allows shell commands, like a read-only agy run, and fails if a command changed files. A hand-off that overruns its own budget is interrupted without another hand-off.

## Review the result

```sh
foreman result doctor-help
```

`result` prints the digest and the latest hand-off, naming the turn it came from. A turn can end without one, so the hand-off may be older than the latest turn. Then, in the worktree:

1. Read `git diff` and `git status`, including new files. Compare every changed path with the contract and with the digest's list of paths outside May change.
2. Read the hand-off's Decisions, review findings and Look closer at sections.
3. Refactor with your own tools so the repo's hooks see the changes.
4. Run the repo's full gate yourself, then commit or merge as asked. foreman never commits or merges.

If the implementation or its self-review is missing, send a follow-up contract with `foreman followup doctor-help --file /tmp/doctor-help-followup.md --wait`. `foreman guide review` has the full checklist.

## Archive

```sh
foreman archive doctor-help
foreman archive doctor-help --keep-worktree
```

Archiving an inactive run moves its records to `runs/.archive/` and frees the name. For a managed worktree it also removes the worktree and branch, but only when the expected branch is checked out, there are no dirty or untracked files, and the branch has no new commits or its tip is merged into the ref it started from. Otherwise it refuses with exit 8. `--keep-worktree` archives the records and leaves the worktree and branch in place. Prepared worktrees are always kept.

Stop any wait or polling loop you started once its run is archived or replaced.

## When a run fails

On `failed`, `lost` or `unknown`, read `foreman status`, `foreman result` and `foreman events` for the run, and look at its worktree before doing anything else.

- `failed` and `interrupted` runs keep their edits. If the approach is sound, send a short follow-up.
- `lost` means supervision ended. Check for leftover processes and the logs before resuming, so two writers don't share the worktree.
- `unknown` means foreman can't confirm execution stopped and keeps the worktree reserved. Don't start another run there.
- A `transient:` hint suggests a short follow-up will work; `usage-limit:` needs plan capacity.

After the same failure twice, stop and ask instead of retrying. `foreman guide recover` and [How it works](how-it-works.md#recovery) go further.
