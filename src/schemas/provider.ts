import { Schema } from "effect";

/**
 * Which coding agent drives a run. Recorded on every run; a record without the field is a
 * Codex run, because every run before 0.4.0 was one.
 */
export const ProviderId = Schema.Literals(["codex", "agy"]);
export type ProviderId = typeof ProviderId.Type;

/** Access a run grants its agent: read-only, or write with no approval prompts. */
export const Access = Schema.Literals(["read-only", "write"]);
export type Access = typeof Access.Type;
