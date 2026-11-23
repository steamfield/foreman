// All landing page copy and reference tables. Facts come from the repository's
// README.md; tests/drift.test.ts checks the commands and exit codes against it.

export const hero = {
  title: "Codex and agy models as subagents for Claude Code.",
  lede: "Claude Code plans the work, writes the contracts and reviews the result. foreman hands the implementation to a Codex model, or to a Gemini model through agy, Google's Antigravity CLI. Each delegate works in its own git worktree, and foreman wakes Claude when one finishes or asks a question. Claude can answer it or change its instructions mid-turn, and nothing is committed until Claude has read the diff. Codex runs on its ChatGPT login and agy on your Google sign-in, so neither needs an API key.",
  // The social card's line under the title; it has room for about 160 characters.
  card: "Claude plans and reviews. Codex and agy's Gemini models implement, each in its own git worktree, and nothing is committed until Claude has read the diff.",
  consoleCaption:
    "A Codex run: the fix-supervisor delegate from foreman's own release, 70 minutes replayed in one, including the question Codex asked and Claude's answer. Codex's events and foreman's output are recorded. Claude's side of the conversation was written for this page.",
};

export const why = {
  title: "Running two agents",
  lede: "If you run Codex or Gemini beside Claude Code yourself, you carry every message between them. foreman gives that job to Claude, which wrote the plan and reviews the result anyway.",
  before: {
    title: "By hand",
    items: [
      "You paste Claude's spec into a Codex or Gemini session and watch it work.",
      "The delegate asks a question while you're at lunch, and the turn sits there.",
      "Its changes land in your checkout, mixed with whatever Claude is doing.",
      "You paste the result back into Claude and ask it to review.",
    ],
  },
  after: {
    title: "Through foreman",
    items: [
      "Claude writes a contract and starts a Codex or agy delegate in a fresh worktree with one command.",
      "foreman holds the delegate's question until Claude answers it, and the turn picks up where it stopped.",
      "Each delegate works in its own worktree on its own branch, away from your checkout.",
      "Claude reads the hand-off and the diff, refactors, runs your checks and commits.",
    ],
  },
};

/** Who fills a role: Claude Code itself, or one of foreman's two providers. */
export type RoleProvider = "claude" | "codex" | "agy";

/** One card in the models section. `evidence` names a recorded run on this page. */
export interface ModelRole {
  name: string;
  model: string;
  provider: RoleProvider;
  job: string;
  evidence?: string;
}

const roles: readonly ModelRole[] = [
  {
    name: "Claude Code",
    model: "orchestrator",
    provider: "claude",
    job: "Plans and architects the change, splits it into contracts, answers delegates' questions, reviews every diff, runs your checks and commits.",
    evidence: "Designed this page and wrote every contract behind it.",
  },
  {
    name: "sol",
    model: "gpt-sol",
    provider: "codex",
    job: "The everyday worker. Implements a written contract, runs the repo's checks and hands back a report. foreman's default model.",
    evidence: "Built the command tabs and llms.txt (site-commands).",
  },
  {
    name: "terra",
    model: "gpt-terra",
    provider: "codex",
    job: "The cheapest model, and effective on narrow work: tests for existing behaviour, classification, mechanical edits.",
    evidence: "Wrote the browser and accessibility tests (site-e2e).",
  },
  {
    name: "astra",
    model: "gpt-astra",
    provider: "codex",
    job: "The design model. Visual work and interface details that need taste, for much less than the same work on Claude's largest models.",
    evidence: "Designed the console replay at the top (site-console).",
  },
  {
    name: "Gemini 4 Neon",
    model: "gemini-4-neon",
    provider: "agy",
    job: "Efforts low to xhigh.",
  },
  {
    name: "Gemini 4 Argon",
    model: "gemini-4-argon",
    provider: "agy",
    job: "Efforts low to high.",
  },
  {
    name: "Gemini 4 Hydrogen",
    model: "gemini-4-hydrogen",
    provider: "agy",
    job: "Efforts low to xhigh.",
  },
  {
    name: "Gemini 3.8 Flash",
    model: "gemini-3.8-flash",
    provider: "agy",
    job: "Efforts low to high.",
  },
];

export const models = {
  title: "A model for each job",
  lede: "Claude Code is best at the long view: planning, architecture, and keeping many tasks moving to a reviewed finish. foreman gives it two providers for the work in between, Codex and agy, and makes their models available the way Claude's own subagents are: start one with a contract, wait on it in the background, answer it, review it.",
  /** Claude Code first, then each provider's models in the order `foreman models` lists them. */
  roles,
  providers: [
    {
      id: "codex",
      name: "Codex",
      summary:
        "OpenAI's Codex CLI, signed in with `codex login` on your ChatGPT plan. Its models are cheaper per task than Claude's largest and good at implementation. foreman starts sol when a run names no model.",
    },
    {
      id: "agy",
      name: "agy",
      summary:
        "Google's Antigravity CLI, signed in with your Google account. It serves Gemini models, and its catalog also lists the other vendors' models your account can use. agy is optional, and foreman only picks it when you name one of its models.",
    },
  ] as const satisfies readonly {
    id: Exclude<RoleProvider, "claude">;
    name: string;
    summary: string;
  }[],
  /** How Claude drives a delegate, as command templates written for this page. */
  loop: [
    "foreman start <name> --new-worktree --contract <file> --model <model> --wait",
    'foreman answer <name> <question-id> "<decision>" --wait',
    'foreman steer <name> "<correction>"',
    "foreman result <name>",
    "foreman archive <name>",
  ],
  /** Introduces the recorded `foreman models` output. */
  routing:
    "The model you name picks the provider. `foreman start --model` looks the name up in each provider's catalog, and the run stays on that provider for every later turn. An agy effort can ride on the id, so `--model gemini-4-neon-high` is the same run as `--model gemini-4-neon --effort high`. When both catalogs list a model, prefix it with `codex:` or `agy:`. `foreman models` prints both catalogs, and this output from it is recorded.",
  guidance:
    "Delegates do their best work when the repository tells them how to work. Codex reads `AGENTS.md` and the rules the contract names, and runs under the same hooks Claude does (`.codex/hooks.json`). agy reads `AGENTS.md`, `GEMINI.md` and `.agents/rules/`, and runs the hooks in `.agents/hooks.json`. Every contract ends with an independent review in a fresh process (`codex exec`, or `agy -p` for an agy run) before the hand-off. Claude still reads the diff, so the review bar doesn't move; Claude's usage goes to planning and review, and the implementation runs on the delegate's own sign-in.",
};

export const session = {
  title: "How a session runs",
  lede: "Claude splits a feature into three tasks and gives each to the Codex model that suits it, then answers a question, redirects a turn and lands all three. The diagram is a simulation with compressed timings, built from the Codex runs that made this page; the commands, states and question text are foreman's.",
};

export const lifecycle = {
  title: "Run states",
  lede: "Every run moves through the same states, on either provider. Claude waits on it in the background and only steps in when foreman reports a question or the end of a turn.",
};

export const handoff = {
  title: "Contracts and digests",
  note: "foreman checks every file the delegate wrote against the contract's `May change` line and lists any strays under `outside May change:`. This is the Codex run that built the replay at the top of this page; it stayed inside its list.",
  lede: "Claude hands the delegate a written contract: the goal, the files it may change, the checks to run and the report to end with. When the turn ends, foreman's digest lists every file the delegate wrote and flags the ones outside the contract's scope.",
};

export const questions = {
  title: "Questions from delegates",
  lede: "A delegate asks through a tool call that foreman holds open. Claude's background wait returns with the question, and the held call resumes once Claude answers. Both questions below are copied from fix-supervisor, a Codex run.",
};

export const parallel = {
  title: "Parallel runs",
  lede: "Each run gets its own worktree and branch, so independent tasks can run at the same time, on one provider or both. One `foreman wait --all` watches every run in the repository and returns when any of them needs Claude.",
  caption:
    "The four Codex delegates that fixed foreman's release blockers, started from the same commit within seconds of each other. Each owned a different set of files.",
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
      "A run can't write files unless it is started with `--write`. Codex enforces this with an OS sandbox; agy refuses its edit tools and fails the run if a shell command changed files.",
    ],
    [
      "One worktree per run",
      "`--new-worktree` creates `.claude/worktrees/<name>` on branch `foreman/<name>`; your checkout is untouched.",
    ],
    [
      "Repo hooks must apply",
      "If the repo has `.codex/hooks.json`, a Codex start refuses until those hooks are trusted in Codex, and an agy start refuses when the worktree has no `.agents/hooks.json`. foreman never approves hooks itself.",
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
      "Your own sign-ins, no API keys",
      "foreman uses the Codex CLI's ChatGPT login and agy's Google sign-in, and removes OpenAI and Gemini key variables from the delegate's environment.",
    ],
    [
      "Budgets and timeouts",
      "A turn's budget defaults to 60 minutes. An unanswered question times out after 15 minutes and the delegate continues with independent work, lists the decision under Open and avoids irreversible steps on it. agy runs cap the question timeout at 100 seconds.",
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
  [
    "2",
    "Invalid command, arguments or input file, including a model no provider lists",
  ],
  ["3", "Invalid configuration"],
  ["4", "Daemon unavailable"],
  ["5", "Codex or agy unavailable (`CodexUnavailable` or `AgyUnavailable`)"],
  [
    "6",
    "Permission denied, including input files, run data, repo hooks, or daemon sockets",
  ],
  ["7", "Run or question not found"],
  ["8", "Run conflict, including unreadable or unsupported run data"],
  ["9", "Invalid worktree or missing dependencies"],
  ["10", "Repo hook trust not confirmed"],
  ["11", "Update failed: the registry check or the install did not complete"],
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
    "Codex CLI 0.171.0, signed in with `codex login`",
    "Optional: agy, Google's Antigravity CLI, signed in by running `agy` once",
    "A git repository with at least one commit",
  ],
  setup: {
    title: "Once per repository",
    lede: "Run `foreman skill install` for the agent entry point, then `foreman guide` for the workflow. For Codex runs, open Codex in the main checkout and trust the project; if the repo has `.codex/hooks.json`, run `/hooks` in Codex and approve them. agy has no trust step, but needs an `.agents/hooks.json` in a repo with Codex hooks. Then check:",
    steps: ["cd /path/to/repo", "codex", "foreman doctor"],
  },
  /** Points to the full guide for the parts this section leaves out. */
  docs: "The docs cover the rest, including agy's hooks and every command.",
  first:
    'foreman start fix-doctor --new-worktree --setup "bun install" --contract contract.md --write --wait',
};
