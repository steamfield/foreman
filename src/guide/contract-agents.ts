/**
 * The parts of the contract templates that depend on which provider runs the delegate: what it
 * loads by itself, where its own config lives, and how it runs the independent review.
 * docs/rfcs/0002-providers.md "The agent experience" sets what each provider's text must say.
 */
import type { ProviderId } from "../schemas/provider";

/** Provider-specific contract text. Multi-line fields carry their own wrapping and no trailing newline. */
export interface ContractAgent {
  /** The name used in sentences: "Codex" or "agy". */
  readonly name: string;
  /** How Claude fills the review placeholders, for the template's opening comment. */
  readonly reviewFill: string;
  /** What the delegate loads itself, for the template's opening comment. */
  readonly loadsItself: string;
  /** Repo instructions the delegate doesn't load, for a "Read first" placeholder. */
  readonly unloadedRules: string;
  /** The "Do not" bullet about the delegate's own config and sign-in. */
  readonly ownConfig: string;
  /** Where the review runs and what the reviewer loads there. */
  readonly reviewWhere: string;
  /** Steps between `mktemp -d` and writing prompt.md, set off by blank lines; empty for Codex. */
  readonly reviewInputs: string;
  /** The review prompt's sentence limiting what the reviewer may do. */
  readonly reviewLimits: string;
  /** The review command block, followed by what to do when it produces nothing. */
  readonly reviewCommand: string;
}

const codex: ContractAgent = {
  name: "Codex",
  reviewFill: `Fill REVIEW MODEL with the
model the digest's run: header shows (the id without any codex: prefix), and check it there.`,
  loadsItself: `Codex loads AGENTS.md from the repo root down to the worktree and lists its installed skills
itself, so don't ask it to read either.`,
  unloadedRules: `CLAUDE.md sections or path-scoped rules the
  repo's Codex hooks don't inject`,
  ownConfig: `- Edit \`~/.codex\` config, hooks, trust or auth. Codex's own runtime session and log writes
  there are fine, including during the independent review.`,
  reviewWhere:
    "Run it from the worktree root, where Codex\nloads AGENTS.md and its installed skills itself.",
  reviewInputs: "",
  reviewLimits: "Your sandbox is read-only; don't run tests or edit files.",
  reviewCommand: `\`\`\`sh
codex exec --ephemeral --sandbox read-only -m "{REVIEW MODEL}" -c 'model_reasoning_effort="high"' -c 'service_tier="priority"' -o "{REVIEW DIR}/review.md" - < "{REVIEW DIR}/prompt.md"
\`\`\``,
};

// agy's print mode takes the prompt as the -p argument (stdin is not read) and can't show a
// permission prompt: it refuses the tool, prints nothing and exits 0. Checked against agy 1.5.14.
const agy: ContractAgent = {
  name: "agy",
  reviewFill: `Fill REVIEW MODEL and REVIEW EFFORT
with the model and effort the digest's run: header shows ("<model> on agy, <effort>": the family,
without any agy: prefix or effort suffix), and check them there. When the effort is none (a
model with a fixed effort), delete --effort "{REVIEW EFFORT}" from the review command.`,
  loadsItself: `agy loads GEMINI.md, AGENTS.md, .agents/rules/ and .agents/skills/ itself, walking from the
worktree to the repo root, so don't ask it to read those.`,
  unloadedRules: `CLAUDE.md sections or \`.claude/rules/\`
  files with no copy in \`.agents/rules/\``,
  ownConfig: `- Edit \`~/.gemini\` config, hooks or sign-in. agy's own conversation and log writes there are
  fine, including during the independent review.`,
  reviewWhere:
    "Run it from the worktree root, where agy\nloads GEMINI.md, AGENTS.md and `.agents/` itself.",
  reviewInputs: `
The reviewer can't run shell commands, so save the changes for it with two more plain
commands, replacing \`{REVIEW DIR}\` with that printed absolute path:

\`\`\`sh
git diff HEAD --output="{REVIEW DIR}/changes.diff"
git status --short --untracked-files=all > "{REVIEW DIR}/status.txt"
\`\`\`

`,
  // One line: the two templates indent the quoted prompt differently.
  reviewLimits:
    "The diff is in <review-directory>/changes.diff and new files are the ?? lines in <review-directory>/status.txt. Make no edits and run no shell commands, not even git: read files with your file tools. A refused edit or command ends this review.",
  reviewCommand: `\`\`\`sh
agy -p "Follow the instructions in {REVIEW DIR}/prompt.md." --add-dir "{REVIEW DIR}" --model "{REVIEW MODEL}" --effort "{REVIEW EFFORT}" --output-format text > "{REVIEW DIR}/review.md" 2> "{REVIEW DIR}/review-errors.txt"
\`\`\`

agy's print mode can't ask for permission. It refuses any edit or shell command the reviewer
tries, writes the reason to \`review-errors.txt\` and exits 0 with an empty \`review.md\`. If
\`review.md\` is empty, read that file and ask the orchestrator; the review did not pass.`,
};

/** The contract text for each provider. */
export const contractAgents: Record<ProviderId, ContractAgent> = { codex, agy };
