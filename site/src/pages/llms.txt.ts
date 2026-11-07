import {
  agentFacing,
  commands,
  exitCodes,
  guardrails,
  hero,
  install,
  models,
  waitOutcomes,
  why,
} from "../data/landing";

import { getPublishedPosts } from "../lib/collection";
import { absolute, postPath } from "../lib/blog";

// Copied from the repository README's Command reference; tests/drift.test.ts compares them.
const commandTable = `| Command | Purpose |
| --- | --- |
| \`guide [<topic>]\` | Print the agent workflow, or contract, contract tests, supervise, review or recover; \`--json\` includes text, topics and mentioned commands |
| \`skill install [--force] [--print]\` | Install the bundled skill under \`$HOME/.claude/skills/foreman/\`, leave an identical copy unchanged, or print it for another agent |
| \`start <name> --new-worktree --contract <file>\` | Create a worktree and start; accepts \`--from\`, \`--setup\`, \`--write\`, \`--model\`, \`--effort\`, \`--tier\`, \`--budget\`, \`--question-timeout\`, \`--skip-deps-check\` |
| \`start <name> --worktree <path> --contract <file>\` | Use a prepared linked worktree inside the main checkout; foreman never removes it or its branch |
| \`status [<name>]\` | Full digest for one run, or a line per run in the group; both JSON forms return \`Digests\` |
| \`events <name> [--after <n>] [--limit <n>] [--verbose]\` | Read up to 100 stored events by default. Text hides protocol chatter and token usage unless \`--verbose\` is set. JSON includes every event in the selected page. |
| \`answer <name> <question-id> [<text>] [--file <path>]\` | Answer now, send a late answer or correct a previous answer |
| \`defer <name> <question-id> [<note>]\` | Release a pending question early |
| \`steer <name> [<message>] [--file <path>]\` | Change the running turn |
| \`followup <name> [<message>] [--file <path>]\` | Start another turn; accepts \`--budget\` and persistent \`--effort\` |
| \`interrupt <name>\` | Request interruption, including cancellation during start preflight |
| \`result <name>\` | Digest and latest available hand-off, naming its turn |
| \`archive <name> [--keep-worktree]\` | Archive an inactive run and clean up its managed worktree, or retain it explicitly |
| \`wait <name>...\` or \`wait --all\` | Wait for attention; accepts \`--after <cursor>\` and \`--timeout <duration>\` |
| \`doctor\` | Inspect config, Codex, hook trust, home permissions and daemon state |
| \`daemon\` / \`daemon stop\` | Run in the foreground / stop when no runs or accepted answers need the daemon |`;

function table(head: readonly string[], rows: readonly (readonly string[])[]) {
  return [head, head.map(() => "---"), ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

export async function GET() {
  const posts = await getPublishedPosts();
  const body = [
    "# foreman",
    `> ${hero.title}`,
    "## What it does",
    hero.lede,
    why.lede,
    `## ${models.title}`,
    models.lede,
    ...models.roles.map(
      (role) => `- ${role.name} (\`${role.model}\`): ${role.job}`,
    ),
    models.guidance,
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
    "Commands below follow `foreman`.",
    commandTable,
    "## Exit codes",
    table(["Code", "Meaning"], exitCodes),
    "## Wait outcomes",
    table(["Outcome", "Meaning"], waitOutcomes),
    `## ${guardrails.title}`,
    ...guardrails.rows.map(([label, meaning]) => `- ${label}: ${meaning}`),
    "## Blog",
    ...posts.map(
      (post) =>
        `- [${post.data.title}](${absolute(postPath(post))}): ${post.data.description}`,
    ),
    "## Reference",
    "- [README on GitHub](https://github.com/steamfield/foreman#readme): Full usage, configuration and command reference.",
  ].join("\n\n");
  return new Response(`${body}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
