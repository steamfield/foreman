import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import manifest from "../package.json";
import { buildIdentity } from "../src/daemon/build";
import { PackageInfo } from "../src/schemas/package";

const metadata = Schema.decodeUnknownSync(PackageInfo)(
  JSON.parse(await readFile("package.json", "utf8")),
);

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--all" && args[0] !== "--npm-host"))
  throw new Error("Usage: bun scripts/build.ts [--all | --npm-host]");

await mkdir("dist", { recursive: true });
const build = await buildIdentity(process.cwd(), Bun.version);
async function compile(outfile: string, target?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "src/bin.ts",
      "--compile",
      "--minify",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--env=disable",
      ...(target ? [`--target=bun-${target}`] : []),
      "--define=COMPILED=true",
      `--define=BUILD=${JSON.stringify(build)}`,
      "--outfile",
      outfile,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const code = await child.exited;
  if (code !== 0) throw new Error(`Build failed for ${target ?? "host"} (exit ${code})`);
}

if (args.length === 0) {
  await compile("dist/forman");
} else {
  if (!metadata.version) throw new Error("npm builds require a package version");
  const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
  const selected = args[0] === "--all" ? targets : [`${process.platform}-${process.arch}`];
  for (const target of selected) {
    if (!targets.includes(target)) throw new Error(`Unsupported npm build target: ${target}`);
    const [os, cpu] = target.split("-");
    const name = `@steamfield/forman-${target}`;
    const optional = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
      manifest.optionalDependencies,
    );
    if (optional[name] !== metadata.version)
      throw new Error(`${name} must use the main package version ${metadata.version}`);
    const directory = `dist/npm/forman-${target}`;
    await mkdir(`${directory}/bin`, { recursive: true });
    await compile(`${directory}/bin/forman`, target);
    await copyFile("LICENSE", `${directory}/LICENSE`);
    await writeFile(
      `${directory}/package.json`,
      `${JSON.stringify(
        {
          name,
          version: metadata.version,
          description: `forman native binary for ${target}`,
          license: manifest.license,
          repository: manifest.repository,
          os: [os],
          cpu: [cpu],
          files: ["bin/forman", "LICENSE"],
        },
        null,
        2,
      )}\n`,
    );
  }
  const main = "dist/npm/forman";
  await mkdir(`${main}/npm`, { recursive: true });
  for (const file of ["LICENSE", "README.md", "npm/forman.cjs"])
    await copyFile(file, `${main}/${file}`);
  await writeFile(
    `${main}/package.json`,
    `${JSON.stringify(
      {
        name: manifest.name,
        version: metadata.version,
        description: manifest.description,
        license: manifest.license,
        repository: manifest.repository,
        homepage: manifest.homepage,
        bugs: manifest.bugs,
        keywords: manifest.keywords,
        type: manifest.type,
        bin: manifest.bin,
        files: manifest.files,
        engines: manifest.engines,
        optionalDependencies: manifest.optionalDependencies,
      },
      null,
      2,
    )}\n`,
  );
}
