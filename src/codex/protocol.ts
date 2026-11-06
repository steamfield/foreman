// The Codex app-server protocol foreman was built against. src/schemas/codex.ts was written
// from `codex app-server generate-ts --experimental` output for this version; regenerate it
// into a scratch directory to read the full types.
//
// schemaHash identifies the protocol: SHA-256 over the files that
// `codex app-server generate-json-schema --experimental --out <dir>` writes, taken in order of
// their `/`-separated paths relative to <dir>, each contributing `<path>\0<content>\0`. The
// daemon regenerates and hashes the schema at startup; a different hash means the protocol
// changed, whatever the version number says.
export const supportedCodex = {
  version: "0.166.0",
  schemaFiles: 467,
  schemaHash: "1285d9e9d90f56591650b8f4cf7fb1d349c2f08468671d27c14846a97023a792",
} as const;
