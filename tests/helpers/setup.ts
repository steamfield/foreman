import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both runners load this before application modules, including when Bun loaded .env.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH|_URL$|LOG_|^FORMAN_/.test(key))
    delete process.env[key];
}
const home = mkdtempSync(join(tmpdir(), "cli-isolation-"));
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
