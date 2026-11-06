import {
  agentFacing,
  commands,
  exitCodes,
  guardrails,
  hero,
  install,
  waitOutcomes,
  why,
} from "../data/landing";

// Command spellings and descriptions follow the repository README's Commands table.
const commandTable = `| Command | What it does |
| --- | --- |
| foreman start <name> --new-worktree [--from <ref>] [--setup "<install>"] --contract <file> | Create an isolated worktree and start the contract; alternatively use --worktree <path>. Accepts --write, --model, --effort, --tier, --budget, --question-timeout, --skip-deps-check |
| foreman status [<name>] | Print one run's digest or one line per run in the current group |
| foreman events <name> [--after <n>] [--limit <n>] | Print normalized events and the next sequence number |
| foreman steer <name> [<message>] [--file <path>] | Send a change to the active turn |
| foreman followup <name> [<message>] [--file <path>] [--budget <dur>] [--effort <e>] | Start another turn |
| foreman interrupt <name> | Interrupt the active turn |
| foreman answer <name> <question-id> [<text>] [--file <path>] | Answer a pending question |
| foreman result <name> | Print the digest and available hand-off, naming its turn |
| foreman archive <name> [--keep-worktree] | Archive an inactive run and safely clean its foreman-created worktree, or explicitly retain it |
| foreman wait [<name>...] [--all] [--after <cursor>] [--timeout <dur>] | Wait for attention, print summaries, digests and turn hand-offs, then the next wait command |
| foreman doctor | Inspect local configuration, Codex, repo hook trust and daemon availability |
| foreman daemon | Run the daemon in the foreground; normally started automatically |
| foreman daemon stop | Stop the daemon when no runs are active; succeeds if none is running |`;

function table(head: readonly string[], rows: readonly (readonly string[])[]) {
  return [head, head.map(() => "---"), ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

export function GET() {
  const body = [
    "# foreman",
    `> ${hero.title}`,
    "## What it does",
    hero.lede,
    why.lede,
    agentFacing.lede,
    "## Install",
    ...install.options.map(
      (option) => `- ${option.label}: \`${option.command}\``,
    ),
    ...install.requirements.map((requirement) => `- ${requirement}`),
    `## ${install.setup.title}`,
    install.setup.lede,
    `\`\`\`sh\n${install.setup.steps.join("\n")}\n\`\`\``,
    "## Commands",
    commands.lede,
    commandTable,
    "## Exit codes",
    table(["Code", "Meaning"], exitCodes),
    "## Wait outcomes",
    table(["Outcome", "Meaning"], waitOutcomes),
    `## ${guardrails.title}`,
    ...guardrails.rows.map(([label, meaning]) => `- ${label}: ${meaning}`),
    "## Reference",
    "- [README on GitHub](https://github.com/steamfield/foreman#readme): Full usage, configuration and command reference.",
  ].join("\n\n");
  return new Response(`${body}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
