// All landing page copy and reference tables. Facts come from the repository's
// README.md; tests/drift.test.ts checks the commands and exit codes against it.

export const hero = {
  title: "Let Claude Code hand work to Codex and supervise it while it runs.",
  lede: "foreman starts Codex in its own git worktree and wakes Claude when Codex finishes or asks a question. Claude can answer it or change its instructions mid-turn, then reviews the diff before anything is committed. It runs on the Codex CLI's ChatGPT login, so there is no OpenAI API key involved.",
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
      "A turn's budget defaults to 60 minutes. On expiry, foreman interrupts, then requests a read-only hand-off with a separate 10-minute budget. An unanswered question times out after 15 minutes and Codex is told to continue independent work, avoid irreversible steps on the decision and list it under Open.",
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

/** README "Exit codes". */
export const exitCodes = [
  ["0", "Success, including wait outcomes and doctor with unavailable probes"],
  ["1", "Internal error"],
  ["2", "Invalid command, arguments or input file"],
  ["3", "Invalid configuration"],
  ["4", "Daemon unavailable"],
  ["5", "Codex unavailable"],
  [
    "6",
    "Permission denied, including input files, run data, repo hooks, or daemon sockets",
  ],
  ["7", "Run or question not found"],
  ["8", "Run conflict, including unreadable or unsupported run data"],
  ["9", "Invalid worktree or missing dependencies"],
  ["10", "Repo hook trust not confirmed"],
  ["130", "Interrupted CLI invocation"],
] as const;

/** README "Wait outcomes". */
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
