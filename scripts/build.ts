import { mkdir, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { buildIdentity } from "../src/daemon/build";
import { PackageInfo } from "../src/schemas/package";

const metadata = Schema.decodeUnknownSync(PackageInfo)(
  JSON.parse(await readFile("package.json", "utf8")),
);

await mkdir("dist", { recursive: true });
const build = await buildIdentity(process.cwd(), Bun.version);
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
    "--define=COMPILED=true",
    `--define=BUILD=${JSON.stringify(build)}`,
    "--outfile",
    `dist/${metadata.name}`,
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
