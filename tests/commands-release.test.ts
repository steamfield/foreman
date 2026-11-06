import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { tempDir } from "./helpers/cli";

const exec = promisify(execFile);

it("packs all five release tarballs and records their exact artifact integrity", async () => {
  const root = await realpath(await tempDir());
  const packages = `${root}/packages`;
  const artifacts = `${root}/artifacts`;
  const names = [
    "forman-darwin-arm64",
    "forman-darwin-x64",
    "forman-linux-x64",
    "forman-linux-arm64",
    "forman",
  ];
  for (const name of names) {
    await mkdir(`${packages}/${name}`, { recursive: true });
    await writeFile(
      `${packages}/${name}/package.json`,
      JSON.stringify({ name: `@steamfield/${name}`, version: "1.2.3" }),
    );
    await writeFile(`${packages}/${name}/LICENSE`, "Test fixture");
  }
  await exec(process.execPath, [resolve("npm/release.cjs"), "pack", packages, artifacts], {
    env: {
      HOME: root,
      PATH: process.env.PATH,
      npm_config_offline: "true",
      npm_config_cache: `${root}/cache`,
    },
  });
  const entries = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        version: Schema.String,
        filename: Schema.String,
        integrity: Schema.String,
      }),
    ),
  )(JSON.parse(await readFile(`${artifacts}/packages.json`, "utf8")));
  expect(entries.map((entry) => entry.name)).toEqual(names.map((name) => `@steamfield/${name}`));
  for (const entry of entries) {
    const bytes = await readFile(`${artifacts}/${entry.filename}`);
    expect(entry.version).toBe("1.2.3");
    expect(entry.integrity).toBe(`sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  }
});

it.each(["partial", "complete", "mismatch", "registry-error", "publish-fails", "unconfirmed"])(
  "release publishing handles %s without publishing main prematurely",
  async (mode) => {
    const root = await realpath(await tempDir());
    const bin = `${root}/bin`;
    await mkdir(bin);
    await mkdir(`${root}/dist/npm`, { recursive: true });
    await symlink(root, `${root}/dist/release`);
    await symlink(resolve("npm"), `${root}/npm`);
    const packages = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "main"].map(
      (target) => ({
        name: target === "main" ? "@steamfield/forman" : `@steamfield/forman-${target}`,
        version: "1.2.3",
        filename: `${target}.tgz`,
        integrity: `sha512-${target}`,
      }),
    );
    await writeFile(`${root}/packages.json`, JSON.stringify(packages));
    for (const entry of packages) {
      const directory = `${root}/dist/npm/${entry.name.split("/")[1]}`;
      await mkdir(directory);
      await writeFile(`${directory}/package.json`, JSON.stringify(entry));
    }
    await writeFile(
      `${root}/registry.json`,
      JSON.stringify(
        Object.fromEntries(
          packages
            .filter((_, index) => mode === "complete" || index === 0)
            .map((entry) => [
              `${entry.name}@${entry.version}`,
              mode === "mismatch" ? "sha512-wrong" : entry.integrity,
            ]),
        ),
      ),
    );
    await writeFile(`${root}/calls.jsonl`, "");
    await writeFile(
      `${bin}/npm`,
      `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify(args) + "\\n");
const registry = JSON.parse(fs.readFileSync(root + "/registry.json"));
if (args[0] === "view") {
  if (mode === "registry-error") { console.log(JSON.stringify({error:{code:"E503"}})); console.error("npm error code E503"); process.exit(1); }
  if (!(args[1] in registry)) { console.log(JSON.stringify({error:{code:"E404"}})); console.error("npm error code E404"); process.exit(1); }
  console.log(JSON.stringify(registry[args[1]]));
} else if (args[0] === "publish") {
  if (mode === "publish-fails") process.exit(1);
  const packages = JSON.parse(fs.readFileSync(root + "/packages.json"));
  const entry = args[1].endsWith(".tgz") ? packages.find(p => args[1].endsWith(p.filename)) : JSON.parse(fs.readFileSync(process.cwd() + "/package.json"));
  if (registry[entry.name + "@" + entry.version]) process.exit(1);
  if (mode !== "unconfirmed") registry[entry.name + "@" + entry.version] = entry.integrity;
  fs.writeFileSync(root + "/registry.json", JSON.stringify(registry));
} else process.exit(2);
`,
      { mode: 0o755 },
    );
    let status = 0;
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const publishStep = workflow
      .split("      - name: Publish platform packages, then main package")[1]
      ?.split("        run: |\n")[1];
    if (!publishStep) throw new Error("Release workflow has no publish step");
    const script = publishStep
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n");
    try {
      await exec("/bin/bash", ["-e", "-c", script], {
        cwd: root,
        env: { HOME: root, PATH: `${bin}:${dirname(process.execPath)}` },
      });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number")
        throw error;
      status = error.code;
    }
    const calls = (await readFile(`${root}/calls.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(line)));
    const published = calls.filter((call) => call[0] === "publish").map((call) => call[1]);
    expect(status).toBe(mode === "partial" || mode === "complete" ? 0 : 1);
    if (mode === "partial") {
      expect(published).toEqual(
        packages.slice(1).map((entry) => `${root}/dist/release/${entry.filename}`),
      );
      const mainPublish = calls.findIndex(
        (call) => call[0] === "publish" && call[1] === `${root}/dist/release/main.tgz`,
      );
      for (const entry of packages.slice(0, 4))
        expect(calls.slice(0, mainPublish)).toContainEqual([
          "view",
          `${entry.name}@${entry.version}`,
          "dist.integrity",
          "--json",
        ]);
    } else if (mode === "complete" || mode === "mismatch" || mode === "registry-error")
      expect(published).toEqual([]);
    else expect(published).toEqual([`${root}/dist/release/darwin-x64.tgz`]);
  },
);
