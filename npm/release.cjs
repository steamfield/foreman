const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const npm = (args) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function pack(source, destination) {
  mkdirSync(destination, { recursive: true });
  const packages = [...targets.map((target) => `forman-${target}`), "forman"].map((name) => {
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
  const expectedNames = [...targets.map((target) => `@steamfield/forman-${target}`), "@steamfield/forman"];
  if (packages.length !== expectedNames.length || packages.some((entry, index) => entry.name !== expectedNames[index]))
    throw new Error("Release must contain all four platform packages followed by the main package.");
  for (const entry of packages) {
    const spec = `${entry.name}@${entry.version}`;
    const existing = publishedIntegrity(spec);
    if (existing === null) {
      process.stdout.write(npm(["publish", resolve(directory, entry.filename), "--provenance", "--access", "public"]));
      if (publishedIntegrity(spec) !== entry.integrity) throw new Error(`Could not confirm published artifact: ${spec}`);
    } else if (existing !== entry.integrity) throw new Error(`Published artifact differs: ${spec}`);
    else console.log(`Verified ${spec}; skipping publish.`);
  }
}

const [command, source, destination] = process.argv.slice(2);
if (command === "pack" && source && destination) pack(source, destination);
else if (command === "publish" && source && !destination) publish(source);
else throw new Error("Usage: node npm/release.cjs pack <packages> <artifacts> | publish <artifacts>");
