/**
 * The fillable implementation contract Claude copies, fills and passes to foreman start. The
 * provider decides what the delegate already loads and how it runs the independent review.
 */
import type { ProviderId } from "../schemas/provider";
import { contractAgents } from "./contract-agents";

/** The implementation contract for a run on the given provider. */
export const contractText = (provider: ProviderId): string => {
  const agent = contractAgents[provider];
  return `# Contract: {TITLE}

<!-- Claude: copy to a scratch file outside the worktree, fill task placeholders and remove
this comment and inapplicable sections. Leave REVIEW DIR for the delegate's mktemp output.
Choose a model from foreman models, fill REVIEW MODEL with its
literal name, pass the same name to foreman start --model, and confirm the digest's run: header.
Start with foreman start <name> --worktree <path> --contract <this-file> --write --model <model>.
Run the printed next: wait command in the background and follow each subsequent next: command.
${agent.loadsItself}
Every file listed below is read before the first edit and resent on every later model call:
list only what this task needs. -->

## Goal

{The observable behaviour to add or change, why, and the design path and section or quoted task.}

## Read first

- {Design sections and existing files whose patterns to follow, with line ranges where useful.}
- {Instructions ${agent.name} does not load itself, such as ${agent.unloadedRules},
  only where they apply to this task.}

Read anything else when the work reaches it, not up front.

## Skills to apply

{Optional; delete this section if not needed. Name installed skills that must apply, and when,
for example "the testing skill for every test". ${agent.name} finds them by name.} If a named skill
is not installed, say so in the hand-off and continue with the repo's rules. Say in the
hand-off where skills changed your approach. The repo's own rules win where they differ.

## Interface

{Signatures, types, schema names, error types and module paths. Cite shared contracts by symbol;
do not rename or redefine them.}

## Scope

- May change: {actual repo-relative paths, each in backticks; a directory ends in \`/\`}.
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

\`\`\`sh
{scoped test command}
{lint command}
{typecheck command}
\`\`\`

Run each new test file three times on its own, then once in the full test suite using
\`{full test suite command}\`. This full-suite run is required even though the orchestrator runs
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
${agent.ownConfig}
- Mention any repository outside this one in a tracked file. External references in the
  contract are for reading only.

## Review before hand-off

Once acceptance checks pass, get one independent review in a fresh ${agent.name} process and resolve
its findings. ${agent.reviewWhere}

Use separate simple commands and the file-writing tool, not a shell function, grouped command,
heredoc or generated shell script. Run from the worktree root:

\`\`\`sh
mktemp -d
\`\`\`

Keep the printed absolute directory as the review directory, outside the worktree.
${agent.reviewInputs}With the file-writing tool, write \`<review-directory>/prompt.md\` containing, in this order:

1. The body of \`{REPO REVIEWER PATH OR NONE}\` without YAML frontmatter, if present.
2. These task instructions:

   "Review uncommitted changes and new files in {ABSOLUTE WORKTREE PATH} against base
   {BASE BRANCH}. Read the contract at {ABSOLUTE CONTRACT PATH} first. ${agent.reviewLimits}
   The author already ran the checks. Check the
   contract and repo rules, including path-scoped rules (such as \`.claude/rules/\`) covering
   the changed files, and report every real defect with a file:line reference."

Then run one plain command, replacing \`{REVIEW DIR}\` with that printed absolute path:

${agent.reviewCommand}

\`{REVIEW MODEL}\` is the literal model name Claude filled in and verified against the run's
digest header, not an environment variable. Read the resulting \`review.md\`. Fix every finding
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
`;
};
