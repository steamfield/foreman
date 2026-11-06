// All landing page copy and reference tables. Facts come from the repository's
// README.md; tests/drift.test.ts checks the commands and exit codes against it.

export const hero = {
  title: "Codex models as subagents for Claude Code.",
  lede: "Claude Code plans the work, writes the contracts and reviews the result. foreman hands the implementation to Codex models, each in its own git worktree, and wakes Claude when one finishes or asks a question. Claude can answer it or change its instructions mid-turn, and nothing is committed until Claude has read the diff. It runs on the Codex CLI's ChatGPT login, so there is no OpenAI API key involved.",
  // The social card's line under the title; it has room for about 160 characters.
  card: "Claude plans and reviews. sol, terra and astra implement, each in its own git worktree, and nothing is committed until Claude has read the diff.",
  consoleCaption:
    "The fix-supervisor delegate from foreman's own release, 70 minutes replayed in one, including the question Codex asked and Claude's answer. Codex's events and foreman's output are recorded. Claude's side of the conversation was written for this page.",
};

export const why = {
  title: "Running two agents",
  lede: "If you run Codex beside Claude Code yourself, you carry every message between them. foreman gives that job to Claude, which wrote the plan and reviews the result anyway.",
  before: {
    title: "By hand",
    items: [
      "You paste Claude's spec into a Codex session and watch it work.",
      "Codex asks a question while you're at lunch, and the turn sits there.",
      "Its changes land in your checkout, mixed with whatever Claude is doing.",
      "You paste the result back into Claude and ask it to review.",
    ],
  },
  after: {
    title: "Through foreman",
    items: [
      "Claude writes a contract and starts Codex in a fresh worktree with one command.",
      "foreman holds Codex's question until Claude answers it, and the turn picks up where it stopped.",
      "Each delegate works in its own worktree on its own branch, away from your checkout.",
      "Claude reads the hand-off and the diff, refactors, runs your checks and commits.",
    ],
  },
};

export const models = {
  title: "A model for each job",
  lede: "Claude Code is best at the long view: planning, architecture, and keeping many tasks moving to a reviewed finish. Codex has models that are cheaper per task and good at the work in between. foreman makes them available to Claude the way its own subagents are: start one with a contract, wait on it in the background, answer it, review it.",
  roles: [
    {
      name: "Claude Code",
      model: "orchestrator",
      job: "Plans and architects the change, splits it into contracts, answers delegates' questions, reviews every diff, runs your checks and commits.",
      evidence: "Designed this page and wrote every contract behind it.",
    },
    {
      name: "sol",
      model: "gpt-sol",
      job: "The everyday worker. Implements a written contract, runs the repo's checks and hands back a report. foreman's default model.",
      evidence: "Built the command tabs and llms.txt (site-commands).",
    },
    {
      name: "terra",
      model: "gpt-terra",
      job: "The cheapest model, and effective on narrow work: tests for existing behaviour, classification, mechanical edits.",
      evidence: "Wrote the browser and accessibility tests (site-e2e).",
    },
    {
      name: "astra",
      model: "gpt-astra",
      job: "The design model. Visual work and interface details that need taste, for much less than the same work on Claude's largest models.",
      evidence: "Designed the console replay at the top (site-console).",
    },
  ],
  /** How Claude drives a delegate, as command templates written for this page. */
  loop: [
    "foreman start <name> --new-worktree --contract <file> --model gpt-sol --wait",
    'foreman answer <name> <question-id> "<decision>" --wait',
    'foreman steer <name> "<correction>"',
    "foreman result <name>",
    "foreman archive <name>",
  ],
  guidance:
    "The delegates get close to Claude's quality when the repository tells them how to work. Codex reads `AGENTS.md` and the rules the contract names, runs under the same hooks Claude does (`.codex/hooks.json`), and every contract ends with an independent review in a fresh Codex process before the hand-off. Claude still reads the diff, so the review bar doesn't move; Claude's usage goes to planning and review, and the implementation runs on your ChatGPT plan.",
};

export const session = {
  title: "How a session runs",
  lede: "Claude splits a feature into three tasks and gives each to a Codex delegate on the model that suits it, then answers a question, redirects a turn and lands all three. The diagram is a simulation with compressed timings; the commands, states and question text are foreman's.",
};

export const lifecycle = {
  title: "Run states",
  lede: "Every run moves through the same states. Claude waits on it in the background and only steps in when foreman reports a question or the end of a turn.",
};

export const handoff = {
  title: "Contracts and digests",
  note: "foreman checks every file Codex wrote against the contract's `May change` line and lists any strays under `outside May change:`. This is the delegate that built the replay at the top of this page; it stayed inside its list.",
  lede: "Claude hands Codex a written contract: the goal, the files it may change, the checks to run and the report to end with. When the turn ends, foreman's digest lists every file Codex wrote and flags the ones outside the contract's scope.",
};

export const questions = {
  title: "Questions from Codex",
  lede: "Codex asks through a tool call that foreman holds open. Claude's background wait returns with the question, and the held call resumes once Claude answers. Both questions below are copied from the fix-supervisor run.",
};

export const parallel = {
  title: "Parallel runs",
  lede: "Each run gets its own worktree and branch, so independent tasks can run at the same time. One `foreman wait --all` watches every run in the repository and returns when any of them needs Claude.",
  caption:
    "The four delegates that fixed foreman's release blockers, started from the same commit within seconds of each other. Each owned a different set of files.",
};

export const commands = {
  title: "Commands",
  lede: "Claude runs these through its shell tool, and every one takes `--json` for a single machine-readable result.",
  recorded:
    "The output is recorded from real runs, including the ones that built this page.",
};

export const guardrails = {
  title: "Safeguards",
  rows: [
    [
      "Read-only by default",
      "Codex can't write files unless the run is started with `--write`.",
    ],
    [
      "One worktree per run",
      "`--new-worktree` creates `.claude/worktrees/<name>` on branch `foreman/<name>`; your checkout is untouched.",
    ],
    [
      "Repo hooks must be trusted",
      "If the repo has `.codex/hooks.json`, start refuses until those hooks are trusted in Codex. foreman never approves hooks itself.",
    ],
    [
      "No commits, no merges",
      "Changes stay uncommitted in the worktree until Claude reviews them. foreman never commits or merges.",
    ],
    [
      "Archive keeps unmerged work",
      "`foreman archive` removes a worktree only when it holds no uncommitted files and its branch is merged or unchanged.",
    ],
    [
      "Your ChatGPT login, no API keys",
      "foreman uses the Codex CLI's login and never passes API key variables from your environment to Codex.",
    ],
    [
      "Budgets and timeouts",
      "A turn stops after its budget (60 minutes by default). An unanswered question times out after 15 minutes and Codex continues with independent work, lists the decision under Open and avoids irreversible steps on it.",
    ],
    [
      "Private state",
      "Run records live under `~/.foreman`, which the daemon restricts to your user (mode 0700).",
    ],
  ] as const,
};

export const agentFacing = {
  title: "Output for agents",
  lede: "Every result ends with a `next:` line naming the command to run next. Its cursor means Claude never sees the same event twice.",
};

/** README "Exit codes" and "Wait outcomes". */
export const exitCodes = [
  ["0", "Success, including wait outcomes and doctor with unavailable probes"],
  ["1", "Internal error"],
  ["2", "Invalid command or arguments"],
  ["3", "Invalid configuration"],
  ["4", "Daemon unavailable"],
  ["5", "Codex unavailable"],
  ["6", "Permission denied"],
  ["7", "Run or question not found"],
  ["8", "Run state conflict"],
  ["9", "Invalid worktree or missing dependencies"],
  ["10", "Repo hook trust not confirmed"],
  ["130", "Interrupted CLI invocation"],
] as const;

/** README "Exit codes" and "Wait outcomes". */
export const waitOutcomes = [
  [
    "events",
    "Attention: question, done, failed, interrupted or lost, with a digest for each reported run",
  ],
  [
    "timeout",
    "No new attention before the deadline; continue with the printed command",
  ],
  ["none", "`--all` has no active runs or unseen attention in the group"],
] as const;

export const install = {
  title: "Install",
  options: [
    { id: "npm", label: "npm", command: "npm i -g @steamfield/foreman" },
    { id: "bun", label: "bun", command: "bun add -g @steamfield/foreman" },
    { id: "npx", label: "npx", command: "npx @steamfield/foreman" },
  ],
  requirements: [
    "macOS or Linux, on arm64 or x64",
    "git, and Node 26 or newer for the npm launcher",
    "Codex CLI 0.166.0, signed in with `codex login`",
    "A git repository with at least one commit",
  ],
  setup: {
    title: "Once per repository",
    lede: "In the main checkout, open Codex and trust the project. If the repo has `.codex/hooks.json`, run `/hooks` in Codex and approve them. Then check:",
    steps: ["cd /path/to/repo", "codex", "foreman doctor"],
  },
  first:
    'foreman start fix-doctor --new-worktree --setup "bun install" --contract contract.md --write --wait',
};
