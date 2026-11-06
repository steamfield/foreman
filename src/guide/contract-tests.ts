export const contractTestsText = `# Contract: acceptance tests for {TITLE}

<!-- Claude: copy outside the worktree, fill task placeholders and remove this comment.
Leave REVIEW DIR for the delegate's mktemp output.
Fill REVIEW MODEL with the literal visible model passed to foreman start --model and confirm
it in the digest's run: header. Use foreman start <name> --worktree <path> --contract <this-file>
--write --model <model>, then background the printed next: wait command and follow each next:. -->

You are the test author, separate from the implementer. Work in this git worktree, not in the
main checkout. Leave changes uncommitted and do not push. Use \`ask_orchestrator\` only when
blocked by something the contract and repo do not settle, or for a decision with real
consequences. Calls pause your work; progress, findings and corrections go in the hand-off.

## Goal

Write failing acceptance tests for {WHAT THE IMPLEMENTER WILL BUILD}. Cover every acceptance
behaviour in the design and the realistic edge cases you identify. {Changed premises and
design items that belong elsewhere rather than in tests.}

## Design

{Quoted design or its path and sections with acceptance behaviours.}

## Interface

{Module paths, exports, signatures, fields, flags and error types from the design, checked
against the existing code. Existing tests and fixtures whose patterns to follow.}

## Scope

- May change: {actual test and fixture paths, each in backticks; a directory ends in \`/\`}.
- Must not change: {actual backticked source, existing test and design paths}.
- Locked: {actual backticked paths, or none}.

Only edit the May change paths. Write no implementation code; test fixtures are fine. Ask the
orchestrator if scope or the interface needs to change. Do not edit existing tests, commit,
merge, remove worktrees or clean up the orchestrator's scratch files.

## Read first

- \`AGENTS.md\`, if present: {testing and conventions sections}.
- {Applicable testing rules, CLAUDE.md sections, tests and helpers. Codex does not automatically
  load Claude's rules or CLAUDE.md.}

## Skills to apply

Find the newest installed Claude Code \`claude-essentials\` marketplace copy:

\`\`\`sh
ce=$(ls -d "$HOME"/.claude/plugins/cache/*/ce/*/ | sort -V | tail -1)
\`\`\`

- \`ce:writing-tests\`: \`\${ce}skills/writing-tests/SKILL.md\` for every test, including
  \`references/waiting-typescript.md\` for tests waiting on processes, sockets, timers or files,
  and \`references/flaky-tests.md\` for isolation and repeat-run checks.
- \`\${ce}skills/architecting-systems/SKILL.md\` and its \`references/structure.md\`, \`coupling.md\`
  and \`boundaries.md\`: before deciding an interface's shape.
- {Other required skills and paths.}

The repo's testing rules win where they differ. Ask if a required skill is missing. Report
where the skills changed your approach.

## Acceptance and test authoring

Tests must assert behaviour through real interfaces with real project dependencies. Stub a
third-party model or API at its boundary. Automated tests must never run real inference.
Real-model checks are development-only and stay out of the project gate, hooks and CI.

Import new symbols from the module paths the design names. A missing export or wrong result
is an expected failure; a typo or broken fixture is not. Name each test after the behaviour
it checks, and make wrong implementations fail without pinning internal structure.

For interruption tests, make the target block at an observable point before interrupting it.
Wait for a socket, marker file or other condition rather than racing a timer against a fast
process. Use isolated resources per test and resolve symlinks in temp paths where relevant.
Read the function producing an id, digest or path rather than guessing its format. Build
expensive shared artifacts once per test file where possible; compare large artifacts by
digest instead of loading both into buffers.

1. Check every design acceptance item against the code. Follow its intent where its description
   of existing code is wrong, and report the discrepancy. Ask about consequential ambiguity.
2. Choose realistic edge cases and write a test for each, alongside the acceptance tests.
3. Run every new test file three times on its own and once in the full test suite. Confirm
   each new test fails for the intended missing behaviour consistently. Distinguish pre-existing
   suite failures from your new expected failures; fix fixture or isolation failures.
4. Run lint and typecheck. Missing imports or exports for not-yet-implemented design symbols
   are expected type errors; everything else in your files must be clean. Do not suppress them.

Run these from the worktree root:

\`\`\`sh
{command for each new test file; run each three times}
{full test suite command; run once with the new tests included}
{lint command}
{typecheck command}
\`\`\`

Do not run the aggregate project gate unless this contract names it. The orchestrator runs it
after implementation and refactoring. QA the tests as the implementer would: check that their
failure messages identify the missing behaviour and the fixtures reach the intended boundary.

## Do not

- Commit or push, or write implementation code.
- Edit an existing or locked test, weaken an assertion or skip a test to get a different result.
- Disable lint, add a cast or suppress a type error to hide a missing import.
- Add mechanisms the design's tests do not need.
- Edit \`~/.codex\` config, hooks, trust or auth. Codex's own runtime session and log writes
  there are fine, including during the independent review.
- Mention any repository outside this one in a tracked file. External references are for
  reading only.

## Review before hand-off

Once the tests fail for the right reasons and the other checks are clean as described above,
get one independent review in a fresh Codex process. Read \`\${ce}agents/code-reviewer.md\` and
the repo reviewer \`{REPO REVIEWER PATH OR NONE}\`, if present.

Run separate simple commands from the worktree root. First:

\`\`\`sh
mktemp -d
\`\`\`

Keep its printed absolute directory outside the worktree. With the file-writing tool, write
\`<review-directory>/prompt.md\`. Include the marketplace reviewer body without frontmatter,
the writing-tests skill and waiting/flaky reference paths, then the repo reviewer body without
frontmatter so repo rules win. Append the full filled contract and these task instructions:

"Review uncommitted changes and new files in {ABSOLUTE WORKTREE PATH} against base
{BASE BRANCH}. These are failing acceptance tests written ahead of implementation. Check
that they assert the design's behaviour, reject wrong implementations and avoid races and
coupling to internals. Your sandbox is read-only; don't run tests or edit files. The author
ran the checks. Report every real defect with a file:line reference."

Then run this one plain command, filling \`{REVIEW DIR}\` with that printed absolute path:

\`\`\`sh
codex exec --ephemeral --sandbox read-only -m "{REVIEW MODEL}" -c 'model_reasoning_effort="high"' -c 'service_tier="priority"' -o "{REVIEW DIR}/review.md" - < "{REVIEW DIR}/prompt.md"
\`\`\`

Use the literal \`{REVIEW MODEL}\` Claude filled in and verified against the run's digest header,
not an environment variable. Do not wrap these steps in a function, braces, a heredoc or a
script. Read \`review.md\`, fix every finding or explain why it is wrong. Do not edit locked
files to resolve findings; report them. Rerun affected checks after fixes and confirm the
tests still fail for the intended reasons. One review only, with no second pass after fixes.
If the review cannot run, ask the orchestrator rather than claiming it passed.

## Hand-off

Leave everything uncommitted and end with this report, naming files and symbols:

1. Summary: what you wrote, in two or three sentences.
2. Files: each created or changed file and why.
3. Interface the tests assume: every new export, module path and signature, field and flag,
   so the implementer's contract can name and lock them.
4. Tests and edge cases: each new test, the behaviour it pins down, its observed failure reason
   before implementation and whether it failed before the fix (or why not applicable).
5. Decisions: choices left open, design discrepancies and where skills changed the approach.
   Name every new mechanism and the acceptance test or contract line that needed it.
6. Checks: each command and result with counts, each new test file's three isolated runs and
   full-suite result, and the QA you ran and what it showed.
7. Review: the review file's absolute path, each finding and its resolution or dispute.
8. Look closer at: tests or assumptions the orchestrator should examine.
9. Open: unfinished work, blockers and questions.
`;
