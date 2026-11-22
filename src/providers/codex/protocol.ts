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
  version: "0.169.0",
  schemaFiles: 479,
  schemaHash: "f7c9371db33a311cea847c5bfcdb9df37875e0fb62cc12966b910e13b6e543da",
} as const;
