import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UpdateResult } from "../src/schemas/update";
import { runCli, tempDir } from "./helpers/cli";

// Fakes for the package managers foreman update shells out to. Each records its argv; `npm view`
// prints the registry's latest version unless told to fail.
async function fakeTools(options: {
  latest?: string;
  viewFails?: boolean;
  installFails?: boolean;
}) {
  const root = await tempDir();
  const bin = join(root, "bin");
  await mkdir(bin);
  const calls = join(root, "calls.log");
  await writeFile(calls, "");
  const tool = (name: string) => `#!/bin/sh
echo "${name} $*" >> "${calls}"
if [ "$1" = "view" ]; then
  ${options.viewFails ? 'echo "npm error code ENOTFOUND" >&2; echo "npm error network request to https://registry.npmjs.org failed" >&2; exit 1' : `echo "${options.latest ?? "0.2.0"}"`}
  exit 0
fi
${options.installFails ? 'echo "npm error code EACCES" >&2; echo "npm error permission denied" >&2; exit 1' : "exit 0"}
`;
  for (const name of ["npm", "bun", "pnpm"]) {
    await writeFile(join(bin, name), tool(name));
    await chmod(join(bin, name), 0o755);
  }
  return {
    root,
    path: `${bin}:/usr/bin:/bin`,
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean),
  };
}

const launchers = {
  npm: "/usr/local/lib/node_modules/@steamfield/foreman/npm/foreman.cjs",
  bun: "/Users/me/.bun/install/global/node_modules/@steamfield/foreman/npm/foreman.cjs",
  pnpm: "/Users/me/Library/pnpm/global/5/node_modules/@steamfield/foreman/npm/foreman.cjs",
  project: "/work/app/node_modules/@steamfield/foreman/npm/foreman.cjs",
};

const run = async (
  args: string[],
  tools: Awaited<ReturnType<typeof fakeTools>>,
  launcher?: string,
) =>
  runCli(args, {
    env: { PATH: tools.path, ...(launcher ? { FOREMAN_LAUNCHER: launcher } : {}) },
  });

describe("foreman update", () => {
  it.each([
    { method: "npm", install: "npm install --global @steamfield/foreman@0.2.0" },
    { method: "bun", install: "bun add --global @steamfield/foreman@0.2.0" },
    { method: "pnpm", install: "pnpm add --global @steamfield/foreman@0.2.0" },
  ] as const)("installs the latest version with $method", async ({ method, install }) => {
    const tools = await fakeTools({});
    const result = await run(["update", "--json"], tools, launchers[method]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(Schema.decodeUnknownSync(UpdateResult)(JSON.parse(result.stdout))).toMatchObject({
      current: "dev",
      latest: "0.2.0",
      method,
      action: "updated",
      command: install,
    });
    // The exact version is installed, so a release landing mid-update can't change what we get.
    expect(await tools.calls()).toEqual(["npm view @steamfield/foreman version", install]);
  });

  it("only reports with --check", async () => {
    const tools = await fakeTools({});
    const result = await run(["update", "--check"], tools, launchers.npm);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("foreman 0.2.0 is available (installed: dev)");
    expect(result.stdout).toContain("Run foreman update to install it.");
    expect(await tools.calls()).toEqual(["npm view @steamfield/foreman version"]);
  });

  it("explains what to do for installs it cannot update", async () => {
    const tools = await fakeTools({});
    const source = await run(["update"], tools);
    expect(source.status).toBe(0);
    expect(source.stdout).toContain("this foreman was not installed from npm");
    expect(source.stdout).toContain("npm install --global @steamfield/foreman");
    const project = await run(["update"], tools, launchers.project);
    expect(project.stdout).toContain("project dependency");
    expect((await tools.calls()).filter((call) => !call.includes(" view "))).toEqual([]);
  });

  it("fails with the cause and a next step when the registry can't be reached", async () => {
    const tools = await fakeTools({ viewFails: true });
    const result = await run(["update"], tools, launchers.npm);
    expect(result.status).toBe(11);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not check the latest foreman version");
    expect(result.stderr).toContain("network request to https://registry.npmjs.org failed");
    expect(result.stderr).toContain("Check your network");
  });

  it("fails with the package manager's error when the install fails", async () => {
    const tools = await fakeTools({ installFails: true });
    const result = await run(["update", "--json"], tools, launchers.npm);
    expect(result.status).toBe(11);
    const envelope = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "");
    expect(envelope.error).toMatchObject({ tag: "UpdateFailed", retryable: true });
    expect(envelope.error.detail).toContain("npm install --global @steamfield/foreman@0.2.0");
    expect(envelope.error.detail).toContain("permission denied");
  });
});
