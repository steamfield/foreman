// Mechanical pre-release rename; this script can be deleted after the release.
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run"))
  throw new Error(
    `Usage: bun ${relative(process.cwd(), fileURLToPath(import.meta.url))} [--dry-run]`,
  );
const dryRun = args.includes("--dry-run");
const oldName = "forman";
const newName = "foreman";
const titleName = `${oldName[0]?.toUpperCase()}${oldName.slice(1)}`;
const pattern = new RegExp(
  `(?<![A-Za-z])(?:${oldName}|${titleName})(?![a-z])|(?<![A-Za-z])${oldName.toUpperCase()}(?![A-Z])`,
  "g",
);
const history = `The name changed from \`${oldName}\` to \`${newName}\` before 0.1.0 because \`${oldName}\` was a misspelling.`;
const self = relative(process.cwd(), fileURLToPath(import.meta.url));
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
let changedFiles = 0;
let replacements = 0;
let moves = 0;

function rewrite(value: string, count: () => void): string {
  return value.replace(pattern, (match) => {
    count();
    if (match === oldName.toUpperCase()) return newName.toUpperCase();
    if (match === titleName) return "Foreman";
    return newName;
  });
}

for (const file of files) {
  // Keep the requested script path stable for reruns, and regenerate lockfiles with Bun.
  if (
    file === self ||
    /(^|\/)(node_modules|dist|\.dev|logs|coverage)(\/|$)/.test(file) ||
    /(^|\/)([^/]*\.lockb?|package-lock\.json|npm-shrinkwrap\.json)$/.test(file)
  )
    continue;
  // Never follow tracked symlinks into untracked files or outside the repository.
  if (!(await lstat(file)).isFile()) continue;
  const bytes = await readFile(file);
  if (bytes.includes(0)) continue;
  // A lossless round trip also excludes non-UTF-8 binary data.
  const original = bytes.toString("utf8");
  if (!Buffer.from(original).equals(bytes)) continue;
  let count = 0;
  // Preserve the RFC's required historical explanation on subsequent runs.
  const updated = original
    .split(history)
    .map((part) => rewrite(part, () => count++))
    .join(history);
  if (count > 0) {
    console.log(`${file}: ${count} replacements`);
    changedFiles++;
    replacements += count;
    if (!dryRun) await writeFile(file, updated);
  }
  const destination = rewrite(file, () => {});
  if (destination !== file) {
    console.log(`move ${file} -> ${destination}`);
    moves++;
    if (!dryRun) {
      await mkdir(dirname(destination), { recursive: true });
      execFileSync("git", ["mv", "--", file, destination]);
    }
  }
}

console.log(
  `${dryRun ? "Dry run" : "Done"}: ${changedFiles} files, ${replacements} replacements, ${moves} path moves`,
);
