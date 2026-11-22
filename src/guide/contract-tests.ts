/**
 * The fillable contract for an independent test author, written ahead of the implementer's. The
 * provider decides what the delegate already loads and how it runs the independent review.
 */
import type { ProviderId } from "../schemas/provider";
import { contractAgents } from "./contract-agents";

/** The test-author contract for a run on the given provider. */
export const contractTestsText = (provider: ProviderId): string => {
  const agent = contractAgents[provider];
  return `# Contract: acceptance tests for {TITLE}

<!-- Claude: copy outside the worktree, fill task placeholders and remove this comment.
Leave REVIEW DIR for the delegate's mktemp output.
Fill REVIEW MODEL with the literal model from foreman models passed to foreman start --model and
confirm it in the digest's run: header. Use foreman start <name> --worktree <path> --contract
<this-file> --write --model <model>, then background the printed next: wait command and follow
each next:.
${agent.loadsItself}
Every file listed below is read before the first edit and resent on every later model call:
list only what this task needs. -->

You are the test author, separate from the implementer.

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

- {Existing tests, helpers and fixtures whose patterns to follow.}
- {Testing instructions ${agent.name} does not load itself, such as ${agent.unloadedRules},
  only where they apply.}

Read anything else when the work reaches it, not up front.

## Skills to apply

{Optional; delete this section if not needed. Name installed skills that must apply, and when,
for example "the testing skill for every test". ${agent.name} finds them by name.} If a named skill
is not installed, say so in the hand-off and continue with the repo's rules. The repo's testing
rules win where they differ. Report where the skills changed your approach.

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
${agent.ownConfig}
- Mention any repository outside this one in a tracked file. External references are for
  reading only.

## Review before hand-off

Once the tests fail for the right reasons and the other checks are clean as described above,
get one independent review in a fresh ${agent.name} process. ${agent.reviewWhere}

Run separate simple commands from the worktree root. First:

\`\`\`sh
mktemp -d
\`\`\`

Keep its printed absolute directory outside the worktree.
${agent.reviewInputs}With the file-writing tool, write
\`<review-directory>/prompt.md\`: the body of \`{REPO REVIEWER PATH OR NONE}\` without
frontmatter, if present, then these task instructions:

"Review uncommitted changes and new files in {ABSOLUTE WORKTREE PATH} against base
{BASE BRANCH}. Read the contract at {ABSOLUTE CONTRACT PATH} first. These are failing
acceptance tests written ahead of implementation. Check that they assert the design's
behaviour, reject wrong implementations and avoid races and coupling to internals, following
the repo's rules, including path-scoped rules (such as \`.claude/rules/\`) covering the changed
files. ${agent.reviewLimits} The author ran the checks. Report every real defect with a file:line reference."

Then run this one plain command, filling \`{REVIEW DIR}\` with that printed absolute path:

${agent.reviewCommand}

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
};
