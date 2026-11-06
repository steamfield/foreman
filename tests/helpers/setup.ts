import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both runners load this before application modules, including when Bun loaded .env.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH|_URL$|LOG_|^FORMAN_/.test(key))
    delete process.env[key];
}
// Git hooks export these (`git rev-parse --local-env-vars`); inherited, they point the
// tests' temporary-repo git commands at the real repository.
for (const key of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
])
  delete process.env[key];
const home = mkdtempSync(join(tmpdir(), "cli-isolation-"));
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
