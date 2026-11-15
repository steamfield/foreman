#!/usr/bin/env bun
// `bun run release <version>`: prepares a release by rewriting every place the version lives, so
// a bump can't miss one. It edits files and updates the lockfile; it never commits, tags or
// pushes. The release workflow publishes when a matching `v<version>` tag is pushed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
process.chdir(root);

const fail = (message: string): never => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
};

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  fail("usage: bun run release <major.minor.patch> (no leading v, no prerelease suffix)");

if (run("git", ["status", "--porcelain"]) !== "") fail("the working tree has uncommitted changes");
if (run("git", ["branch", "--show-current"]) !== "main") fail("release from main");
if (run("git", ["tag", "--list", `v${version}`]) !== "") fail(`tag v${version} already exists`);

const manifestPath = "package.json";
const manifest = readFileSync(manifestPath, "utf8");
const previous = /"version": "(\d+\.\d+\.\d+)"/.exec(manifest)?.[1];
if (!previous) fail("no version found in package.json");
if (previous === version) fail(`package.json is already at ${version}`);

if (!readFileSync("CHANGELOG.md", "utf8").includes(`## [${version}]`))
  fail(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section: write it first`);

const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
let nextManifest = manifest.replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`);
for (const platform of platforms) {
  const pattern = new RegExp(`("@steamfield/foreman-${platform}": )"\\d+\\.\\d+\\.\\d+"`);
  if (!pattern.test(nextManifest)) fail(`package.json has no optionalDependency for ${platform}`);
  nextManifest = nextManifest.replace(pattern, `$1"${version}"`);
}
writeFileSync(manifestPath, nextManifest);

const rewrite = (file: string, pattern: RegExp, replacement: string) => {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) fail(`${file} no longer matches ${pattern}: update scripts/release.ts`);
  writeFileSync(file, text.replace(pattern, replacement));
};
rewrite("AGENTS.md", /^foreman \d+\.\d+\.\d+ lets/m, `foreman ${version} lets`);
rewrite(
  "docs/architecture.md",
  /^# foreman \d+\.\d+\.\d+ architecture/m,
  `# foreman ${version} architecture`,
);

run("bun", ["install"]);

console.log(`Prepared ${previous} -> ${version}. Next:
  bun run check
  git add -A && git commit -m "chore(release): ${version}"
  git tag v${version}
  git push origin main v${version}`);
