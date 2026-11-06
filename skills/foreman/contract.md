# Contract: {TITLE}

<!-- Claude: copy to a scratch file outside the worktree, fill task placeholders and remove
this comment and inapplicable sections. Leave REVIEW DIR for the delegate's mktemp output.
Choose a visible model, fill REVIEW MODEL with its
literal name, pass the same name to foreman start --model, and confirm the digest's run: header.
Start with foreman start <name> --worktree <path> --contract <this-file> --write --model <model>.
Run the printed next: wait command in the background and follow each subsequent next: command. -->

You are working in a git worktree for an orchestrator who reviews, refactors and commits your
work. Work here, not in the main checkout. Leave changes uncommitted and do not push.
Ask through `ask_orchestrator` only when blocked by something the contract and repo do not
settle, or when a decision with real consequences is needed. Those calls pause your work.
Progress reports, findings and corrections go in the hand-off, not in questions.

## Goal

{The observable behaviour to add or change, why, and the design path and section or quoted task.}

## Read first

- `AGENTS.md`, if present: {applicable sections}.
- {Applicable rule and convention paths, including Claude rules and CLAUDE.md sections that
  Codex does not load automatically.}
- {Design sections and existing files whose patterns to follow.}

## Skills to apply

Find the newest installed Claude Code `claude-essentials` marketplace copy:

```sh
ce=$(ls -d "$HOME"/.claude/plugins/cache/*/ce/*/ | sort -V | tail -1)
```

Read the applicable skills; say in the hand-off where they changed your approach. If a required
skill is missing, ask the orchestrator. The repo's own rules win where they differ.

- `ce:writing-tests`: `${ce}skills/writing-tests/SKILL.md` for every test, including
  `references/waiting-typescript.md` for tests waiting on processes, sockets, timers or files,
  and `references/flaky-tests.md` for isolation and repeat-run checks.
- `${ce}skills/architecting-systems/SKILL.md` and its `references/structure.md`, `coupling.md`
  and `boundaries.md`: before changing a module, service, schema or contract.
- `${ce}skills/handling-errors/SKILL.md`: for error handling you add.
- {Other skills the task needs, with their paths.}

## Interface

{Signatures, types, schema names, error types and module paths. Cite shared contracts by symbol;
do not rename or redefine them.}

## Scope

- May change: {actual repo-relative paths, each in backticks; a directory ends in `/`}.
- Must not change: {actual backticked paths, plus any public contracts or other restrictions}.
- Locked: {actual backticked paths of tests another delegate wrote, or none}.

Edit no file outside May change. If the task cannot be done inside it, ask the orchestrator
before expanding scope. Make locked tests pass without editing them; report a suspected error.
Do not commit, merge, remove worktrees or clean up the orchestrator's scratch files.

## Acceptance

{Required behaviours and tests. A bug fix starts with a failing regression test.}

{For performance work: measure at the target size and report time per phase before optimizing,
unless the contract already identifies the hot path.}

{For a cache, cursor or incremental pass: list every table, setting and file read, with tests
that changing each one invalidates the result.}

Run from the worktree root and iterate until the checks pass:

```sh
{scoped test command}
{lint command}
{typecheck command}
```

Run each new test file three times on its own, then once in the full test suite using
`{full test suite command}`. This full-suite run is required even though the orchestrator runs
the full project gate after refactoring. Don't run the aggregate gate yourself unless this
contract names it. Report unrelated failures without weakening or skipping tests. Name any
test file outside your scope that the change could affect.

Tests assert observable behaviour through real project interfaces and dependencies. Stub a
third-party model or API at its boundary. Automated tests must never run real inference.
Real-model checks are development-only and stay out of the project gate, hooks and CI.
Wait for observable conditions rather than sleeping; isolate temp files, ports and state so
the tests work together as well as alone.

Then QA as the first user: build and exercise the changed flow, including realistic failures.
Fix friction, with a regression test before each bug fix, then rerun affected checks. For work
with nothing new to run, explain that and QA what can be exercised.

## Do not

- Commit or push; leave changes for review.
- Disable lint, weaken a test, add a cast or suppress a type error to get green.
- Add features, options, abstractions or mechanisms the goal and acceptance do not need.
- Edit `~/.codex` config, hooks, trust or auth. Codex's own runtime session and log writes
  there are fine, including during the independent review.
- Mention any repository outside this one in a tracked file. External references in the
  contract are for reading only.

## Review before hand-off

Once acceptance checks pass, get one independent review in a fresh Codex process and resolve
its findings. Read `${ce}agents/code-reviewer.md`. If the repo has its own reviewer agent,
read `{REPO REVIEWER PATH OR NONE}` too; use its body last so repo guidance wins.

Use separate simple commands and the file-writing tool, not a shell function, grouped command,
heredoc or generated shell script. Run from the worktree root:

```sh
mktemp -d
```

Keep the printed absolute directory as the review directory, outside the worktree. With the
file-writing tool, write `<review-directory>/prompt.md` containing, in this order:

1. The marketplace reviewer agent body without YAML frontmatter.
2. The applicable skill paths, including writing-tests and its waiting/flaky references.
3. The repo reviewer body without frontmatter, if present.
4. These task instructions and the full filled contract:

   "Review uncommitted changes and new files in {ABSOLUTE WORKTREE PATH} against base
   {BASE BRANCH}. Your sandbox is read-only; don't run tests or edit files. The author already
   ran the checks. Check the contract and repo rules and report every real defect with a
   file:line reference."

Then run one plain command, replacing `{REVIEW DIR}` with that printed absolute path:

```sh
codex exec --ephemeral --sandbox read-only -m "{REVIEW MODEL}" -c 'model_reasoning_effort="high"' -c 'service_tier="priority"' -o "{REVIEW DIR}/review.md" - < "{REVIEW DIR}/prompt.md"
```

`{REVIEW MODEL}` is the literal model name Claude filled in and verified against the run's
digest header, not an environment variable. Read the resulting `review.md`. Fix every finding
or explain in the hand-off why it is wrong. A finding about a locked file goes to the
orchestrator. A bug finding gets a regression test before the fix, verified to fail without
the fix; a temporary probe does not count. Rerun affected acceptance checks after fixing.
One independent review only; do not review again after the fixes. If the review cannot run,
ask the orchestrator rather than claiming it passed.

## Hand-off

Finish when findings are resolved and acceptance passes, or when blocked. Leave everything
uncommitted and end with this report, naming files and symbols:

1. Summary: what you built, in two or three sentences.
2. Files: each file created or changed and why.
3. Decisions: choices left open, deviations and why, and where skills changed the approach.
   Name every new mechanism and the acceptance test or contract line that needed it.
4. Checks: each command and result with test counts; each new test, the behaviour it pins down
   and whether it failed before the fix (or why not applicable); each new file's three isolated
   runs and full-suite result. Include QA: what you ran, judged and changed.
5. Review: the review file's absolute path, each finding and its resolution or dispute.
6. Look closer at: assumptions, edge cases or tests the orchestrator should examine.
7. Open: unfinished work, blockers and questions.
