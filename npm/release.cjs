const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
// What each npm failure code means in this pipeline, shown under the failure so a red run explains itself.
const hints = {
  EOTP: "npm asked for a one-time password, so this was not an OIDC publish. Check the package's Trusted Publisher (steamfield/foreman, release.yml) and that no NODE_AUTH_TOKEN is set.",
  ENEEDAUTH: "npm had no credentials. Trusted publishing needs `id-token: write` on the job and a Trusted Publisher on the package.",
  E401: "npm rejected the credentials. Check the package's Trusted Publisher (steamfield/foreman, release.yml).",
  E403: "npm refused this publish: the package's Trusted Publisher is missing or does not match this repository and workflow, or the version already exists.",
  E404: "npm could not find the package or scope. A new package must be published once by hand before a Trusted Publisher can be configured.",
  E422: "npm rejected the provenance. Provenance needs a public repository and `id-token: write`.",
};

// Run npm and fail with the command, npm's own error lines and a hint, not a dump of the child process.
// stdout is kept on the error because `npm view --json` reports registry errors there.
function npm(args) {
  try {
    return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const code = /^npm error code (\w+)/m.exec(stderr)?.[1];
    const lines = stderr
      .split("\n")
      .filter((line) => line.startsWith("npm error") && !line.startsWith("npm error code") && !line.includes("A complete log"))
      .map((line) => line.replace(/^npm error ?/, "").trim())
      .filter(Boolean)
      .slice(0, 6);
    const target = args.map((arg) => (arg.includes("/") ? arg.split("/").slice(-1)[0] : arg)).slice(0, 2).join(" ");
    const failure = new Error(
      [`npm ${target} failed${code ? ` (${code})` : ""}`, ...lines.map((line) => `  ${line}`), ...(hints[code] ? [`Hint: ${hints[code]}`] : [])].join("\n"),
      { cause: error },
    );
    failure.stdout = error.stdout;
    throw failure;
  }
}

function pack(source, destination) {
  mkdirSync(destination, { recursive: true });
  const packages = [...targets.map((target) => `foreman-${target}`), "foreman"].map((name) => {
    const [packed] = JSON.parse(npm(["pack", resolve(source, name), "--json", "--pack-destination", resolve(destination)]));
    return { name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity };
  });
  writeFileSync(join(destination, "packages.json"), JSON.stringify(packages));
}

function publishedIntegrity(spec) {
  let output;
  try {
    output = npm(["view", spec, "dist.integrity", "--json"]);
  } catch (error) {
    // Only an explicit registry 404 means the version can be published.
    let diagnostic;
    try {
      diagnostic = JSON.parse(error.stdout);
    } catch {
      throw error;
    }
    if (diagnostic.error?.code === "E404") return null;
    throw error;
  }
  return JSON.parse(output);
}

function publish(directory) {
  const packages = JSON.parse(readFileSync(join(directory, "packages.json"), "utf8"));
  const expectedNames = [...targets.map((target) => `@steamfield/foreman-${target}`), "@steamfield/foreman"];
  if (packages.length !== expectedNames.length || packages.some((entry, index) => entry.name !== expectedNames[index]))
    throw new Error("Release must contain all four platform packages followed by the main package.");
  const done = [];
  for (const entry of packages) {
    const spec = `${entry.name}@${entry.version}`;
    try {
      const existing = publishedIntegrity(spec);
      if (existing === null) {
        console.log(`Publishing ${spec}`);
        process.stdout.write(npm(["publish", resolve(directory, entry.filename), "--provenance", "--access", "public"]));
        if (publishedIntegrity(spec) !== entry.integrity)
          throw new Error(`Could not confirm ${spec} on the registry after publishing. The registry may be lagging: rerun the job, it skips versions already published.`);
        done.push(spec);
      } else if (existing !== entry.integrity)
        throw new Error(`${spec} is already on npm with different contents. Never republish a version: bump the patch and tag again.`);
      else {
        console.log(`Verified ${spec}; skipping publish.`);
        done.push(spec);
      }
    } catch (error) {
      const remaining = packages.slice(done.length).map((item) => `${item.name}@${item.version}`);
      throw new Error(
        `${error.message}\nPublished or verified: ${done.length === 0 ? "nothing" : done.join(", ")}.\nNot published: ${remaining.join(", ")}.\nAfter fixing the cause, rerun the failed job: it skips what is already on npm.`,
        { cause: error },
      );
    }
  }
}

// One readable line group on stderr plus a GitHub annotation, instead of Node's stack trace.
function report(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.GITHUB_ACTIONS) console.error(`::error title=Release publish failed::${message.replace(/\n/g, "%0A")}`);
  console.error(`release: ${message}`);
  process.exitCode = 1;
}

const [command, source, destination] = process.argv.slice(2);
try {
  if (command === "pack" && source && destination) pack(source, destination);
  else if (command === "publish" && source && !destination) publish(source);
  else throw new Error("Usage: node npm/release.cjs pack <packages> <artifacts> | publish <artifacts>");
} catch (error) {
  report(error);
}
