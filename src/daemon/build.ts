import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Shared by the build script and source entry point; paths and contents, never mtimes.
export async function buildIdentity(root: string, runtime: string) {
  const sources = await readdir(join(root, "src"), { recursive: true });
  const files = [
    "package.json",
    "bun.lock",
    "scripts/build.ts",
    ...sources.filter((file) => file.endsWith(".ts")).map((file) => `src/${file}`),
  ].sort();
  const hash = createHash("sha256").update(runtime);
  for (const file of files) {
    hash.update(`\0${file}\0`);
    hash.update(await readFile(join(root, file)));
  }
  return hash.digest("hex");
}
