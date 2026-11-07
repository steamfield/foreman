// Test-owned content used by production, Pages and manual browser probes.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const fixtureDescription =
  "Run Codex in a separate git worktree, answer questions while it works, and review the resulting changes before you commit them.";
export function fixturePost({
  title = "Run Codex in a git worktree",
  headline = `${title}: a practical guide`,
  description = fixtureDescription,
  keyword = "run Codex <in> a git worktree",
  status = "published",
  date = "2026-01-01",
  feature = "worktrees",
  demo = true,
} = {}) {
  return `---\ntitle: ${JSON.stringify(title)}\nheadline: ${JSON.stringify(headline)}\ndescription: ${JSON.stringify(description)}\ndate: ${date}\nupdated: 2026-02-01\nkeyword: ${JSON.stringify(keyword)}\nfeature: ${feature}\nstatus: ${status}\n---\n\n${demo ? 'import CommandDemo from "../../components/blog/CommandDemo.astro";\n' : ""}
## Prepare the worktree

Check the [setup requirements](/#install), then [review the result](#review-the-result).

> Keep your work isolated until the review is complete.

\`\`\`sh
 git worktree list
\`\`\`

## Run the contract

${demo ? '<CommandDemo command="doctor" caption="Recorded environment and repo trust checks." />\n\n<CommandDemo command="doctor" caption="The same recording can appear twice without duplicate IDs." />' : "Use the documented contract."}

## Review the result

Read the diff before committing. Return to the [blog](/blog).
`;
}

export function buildFixtureSite() {
  const root = mkdtempSync(join(tmpdir(), "foreman-pipeline-"));
  try {
    for (const file of [
      "src",
      "fixtures",
      "public",
      "scripts",
      "astro.config.mjs",
      "tsconfig.json",
      "package.json",
    ])
      cpSync(file, join(root, file), { recursive: true });
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(
      join(root, ".env.production"),
      "PUBLIC_POSTHOG_KEY=phc_test\n",
    );
    const content = join(root, "src/content/blog");
    rmSync(content, { recursive: true, force: true });
    mkdirSync(join(content, "notes"), { recursive: true });
    writeFileSync(join(content, "engine-probe.mdx"), fixturePost());
    writeFileSync(join(content, "edge-cases.mdx"), edgeCasePost());
    for (const status of ["draft", "unlisted"])
      writeFileSync(
        join(content, `${status}.mdx`),
        fixturePost({ title: status, status, demo: false }),
      );
    writeFileSync(
      join(content, "notes/index.mdx"),
      fixturePost({
        title: "Nested post",
        date: "2026-01-02",
        feature: "hooks",
        demo: false,
      }),
    );
    const built = spawnSync("bunx", ["--no-install", "astro", "build"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PUBLIC_POSTHOG_KEY: "phc_test" },
    });
    if (built.status !== 0)
      throw new Error(
        `Fixture build failed:\n${built.stdout}\n${built.stderr}`,
      );
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function edgeCasePost() {
  return (
    fixturePost({
      title: ` ${"W".repeat(48)} `,
      headline: ` ${"W".repeat(110)} `,
      description: ` ${fixtureDescription} `,
      keyword: " Codex worktrees ",
      date: "2026-01-03",
    }) +
    "\n<details><summary>Additional notes</summary><p>Extra context in an authored disclosure.</p></details>\n"
  );
}
