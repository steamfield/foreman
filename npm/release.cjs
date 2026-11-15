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
  E404: "npm returned 404 for a package that may exist: on publish this usually means the OIDC login failed, so check the package's Trusted Publisher matches this repository and workflow exactly (steamfield/foreman, release.yml, no environment) and that the runner npm is 11.5.1 or newer. It can also mean the scope does not exist or a new package was never published by hand.",
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
    failure.npmCode = code;
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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const specOf = (entry) => `${entry.name}@${entry.version}`;

// npm reports a publish well before the registry serves it, usually within 3-5 minutes. Wait for the
// first check, then poll. A different integrity is a real conflict and fails at once.
function confirmPublished(entries, state) {
  if (entries.length === 0) return;
  const delay = Number(process.env.RELEASE_CONFIRM_DELAY_MS ?? 120000);
  const interval = Number(process.env.RELEASE_CONFIRM_INTERVAL_MS ?? 15000);
  const attempts = Number(process.env.RELEASE_CONFIRM_ATTEMPTS ?? 20);
  console.log(`Waiting for the registry to show ${entries.map(specOf).join(", ")}`);
  sleep(delay);
  let waiting = entries;
  for (let attempt = 1; ; attempt++) {
    waiting = waiting.filter((entry) => {
      const found = publishedIntegrity(specOf(entry));
      if (found === null) return true;
      if (found !== entry.integrity) throw new Error(`${specOf(entry)} is on npm with different contents than the build.`);
      console.log(`Confirmed ${specOf(entry)}`);
      state.unconfirmed.splice(state.unconfirmed.indexOf(specOf(entry)), 1);
      state.done.push(specOf(entry));
      return false;
    });
    if (waiting.length === 0) return;
    if (attempt >= attempts)
      throw new Error(
        `Could not confirm ${waiting.map(specOf).join(", ")} on the registry after ${Math.round((delay + attempts * interval) / 1000)}s. npm reported the publish, so rerun the job: it skips versions already published.`,
      );
    sleep(interval);
  }
}

// Publish every entry not yet on npm, then wait for the registry to show them as a group.
function publishEntries(directory, entries, state) {
  const published = [];
  for (const entry of entries) {
    const spec = specOf(entry);
    const existing = publishedIntegrity(spec);
    if (existing === null) {
      console.log(`Publishing ${spec}`);
      try {
        process.stdout.write(npm(["publish", resolve(directory, entry.filename), "--provenance", "--access", "public"]));
      } catch (error) {
        // An earlier run published this version and the registry is not serving it yet.
        if (error.npmCode !== "E409") throw error;
        console.log(`${spec} was already published; waiting for the registry.`);
      }
      state.unconfirmed.push(spec);
      published.push(entry);
    } else if (existing !== entry.integrity)
      throw new Error(`${spec} is already on npm with different contents. Never republish a version: bump the patch and tag again.`);
    else {
      console.log(`Verified ${spec}; skipping publish.`);
      state.done.push(spec);
    }
  }
  confirmPublished(published, state);
}

// The four platform packages go first and must be visible before the main package that depends on them.
function publish(directory) {
  const packages = JSON.parse(readFileSync(join(directory, "packages.json"), "utf8"));
  const expectedNames = [...targets.map((target) => `@steamfield/foreman-${target}`), "@steamfield/foreman"];
  if (packages.length !== expectedNames.length || packages.some((entry, index) => entry.name !== expectedNames[index]))
    throw new Error("Release must contain all four platform packages followed by the main package.");
  const state = { done: [], unconfirmed: [] };
  try {
    publishEntries(directory, packages.slice(0, -1), state);
    publishEntries(directory, packages.slice(-1), state);
  } catch (error) {
    const rest = packages.map(specOf).filter((spec) => !state.done.includes(spec) && !state.unconfirmed.includes(spec));
    const list = (items) => (items.length === 0 ? "none" : items.join(", "));
    throw new Error(
      `${error.message}\nOn npm: ${list(state.done)}.\nPublished but not yet visible: ${list(state.unconfirmed)}.\nNot published: ${list(rest)}.\nAfter fixing the cause, rerun the failed job: it skips what is already on npm.`,
      { cause: error },
    );
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
