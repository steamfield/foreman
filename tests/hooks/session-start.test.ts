import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, makeFixture, runHook } from "../helpers/hooks";

let project: Fixture;

beforeEach(() => {
  project = makeFixture();
});
afterEach(() => project.cleanup());

// What `docker compose config` prints for compose.yaml without the deploy's variables set.
const MISSING_VARIABLE =
  "error while interpolating services.api.ports.[]: required variable DEPLOY_PORT is missing a value: set DEPLOY_PORT";

/**
 * A `docker` stand-in: `compose ... config` and `compose ... ps` exit with the given codes, and a
 * failing `config` prints `configError` on stderr.
 */
function fakeDocker({
  config,
  ps,
  running = "",
  configError = MISSING_VARIABLE,
}: {
  config: number;
  ps: number;
  running?: string;
  configError?: string;
}) {
  const bin = join(project.dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
case " $* " in
  *" config "*) if [ ${config} -eq 0 ]; then echo api; else echo ${JSON.stringify(configError)} >&2; fi; exit ${config} ;;
  *" ps "*) [ ${ps} -eq 0 ] && printf '%s' "${running}"; exit ${ps} ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

async function sessionStart(env: Record<string, string> = {}) {
  const result = await runHook(
    "SessionStart",
    "session-start",
    { session_id: "s", hook_event_name: "SessionStart", source: "startup" },
    { env: { CLAUDE_PROJECT_DIR: project.dir, ...env } },
  );
  expect(result.code).toBe(0);
  return result.stdout;
}

describe("session-start", { timeout: 30_000 }, () => {
  it("doesn't ask for a .env the app doesn't need", async () => {
    writeFileSync(join(project.dir, ".env.example"), "PORT_API=3000\n");
    expect(await sessionStart()).not.toContain(".env");
  });

  it("stays quiet about a compose file that only a deploy can read", async () => {
    writeFileSync(join(project.dir, "compose.yaml"), "services: {}\n");
    const out = await sessionStart({ PATH: fakeDocker({ config: 1, ps: 0 }) });
    expect(out).not.toContain("Docker");
    expect(out).not.toContain("compose.yaml");
  });

  it("says a compose file that fails for another reason can't be read", async () => {
    writeFileSync(join(project.dir, "compose.yaml"), "services: [\n");
    const out = await sessionStart({
      PATH: fakeDocker({
        config: 15,
        ps: 0,
        configError: "yaml: line 2: did not find expected node content",
      }),
    });
    expect(out).toContain("docker compose can't read compose.yaml");
    expect(out).not.toContain("Docker isn't responding");
  });

  it("says Docker isn't responding only when the daemon doesn't answer", async () => {
    writeFileSync(join(project.dir, "compose.yaml"), "services: {}\n");
    const out = await sessionStart({ PATH: fakeDocker({ config: 0, ps: 1 }) });
    expect(out).toContain("Docker isn't responding");
  });

  it("names a declared service that isn't running", async () => {
    writeFileSync(join(project.dir, "compose.yaml"), "services: {}\n");
    expect(await sessionStart({ PATH: fakeDocker({ config: 0, ps: 0 }) })).toContain(
      "not running: api",
    );
    expect(
      await sessionStart({ PATH: fakeDocker({ config: 0, ps: 0, running: "api" }) }),
    ).not.toContain("not running");
  });
});
