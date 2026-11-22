/**
 * agy's repo hooks: where a worktree's `hooks.json` lives and whether a start can trust it.
 * agy loads workspace hooks with no trust step and reports no hook runs over ACP, so foreman
 * checks the file decodes and refuses repos whose guards exist only for Codex.
 */
import { Effect, FileSystem, Schema } from "effect";
import { PermissionDenied, RepoHooksUntrusted } from "../../errors";
import type { HookTrust } from "../contract";

/** The directories agy reads workspace hooks from, in its precedence order. */
export const AGY_HOOK_DIRS = [".agents", ".agent", "_agents", "_agent"] as const;

const HOOKS_FILE = "hooks.json";
const CODEX_HOOKS_FILE = ".codex/hooks.json";

const Handler = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("command")),
  command: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
});
const MatcherGroup = Schema.Struct({
  matcher: Schema.optionalKey(Schema.String),
  hooks: Schema.Array(Handler),
});
// Tool events wrap handlers in a matcher group; the other events list handlers directly.
const EventEntries = Schema.Array(Schema.Union([MatcherGroup, Handler]));
const NamedHook = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  SessionStart: Schema.optionalKey(EventEntries),
  PreToolUse: Schema.optionalKey(EventEntries),
  PostToolUse: Schema.optionalKey(EventEntries),
  PreInvocation: Schema.optionalKey(EventEntries),
  PostInvocation: Schema.optionalKey(EventEntries),
  Stop: Schema.optionalKey(EventEntries),
});
const HooksFile = Schema.fromJsonString(Schema.Record(Schema.String, NamedHook));

/**
 * Whether a file or symlink exists at the path. lstat, not stat: a dangling symlink counts, so
 * the repo isn't treated as unguarded. NotFound and BadResource (a parent that is a regular
 * file, ENOTDIR) both mean there is no file there.
 */
const pathExists = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.lstat(file).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    Effect.catchReason("PlatformError", "BadResource", () => Effect.succeed(false)),
  );
});

/**
 * Returns the first `hooks.json` agy would load from the worktree, or null when there is none.
 * A dangling symlink counts as present.
 * @throws {PermissionDenied} When a hook directory can't be inspected.
 */
export const findAgyHooks = Effect.fn("agy.findAgyHooks")(function* (worktree: string) {
  for (const dir of AGY_HOOK_DIRS) {
    const candidate = `${worktree}/${dir}/${HOOKS_FILE}`;
    const found = yield* pathExists(candidate).pipe(
      Effect.mapError(
        (error) =>
          new PermissionDenied({
            detail: `Cannot inspect agy hooks at ${candidate} (${error.message}). Fix the permissions, then run foreman doctor.`,
          }),
      ),
    );
    if (found) return candidate;
  }
  return null;
});

const untrusted = (hooksPath: string, reason: string) =>
  new RepoHooksUntrusted({
    detail: `agy can't load ${hooksPath}: ${reason}. Fix the file, then run foreman doctor.`,
  });

const checkHooksFileDecodes = Effect.fnUntraced(function* (hooksPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(hooksPath)
    .pipe(Effect.mapError((error) => untrusted(hooksPath, `it can't be read (${error.message})`)));
  yield* Schema.decodeUnknownEffect(HooksFile)(text).pipe(
    Effect.mapError((error) =>
      untrusted(hooksPath, `it doesn't match agy's hooks schema (${error.message})`),
    ),
  );
});

const hasCodexHooks = Effect.fnUntraced(function* (mainCheckout: string) {
  const codexHooks = `${mainCheckout}/${CODEX_HOOKS_FILE}`;
  return yield* pathExists(codexHooks).pipe(
    Effect.mapError(
      (error) =>
        new RepoHooksUntrusted({
          detail: `Could not inspect ${codexHooks} (${error.message}). Check its permissions, then run foreman doctor.`,
        }),
    ),
  );
});

/**
 * Checks the worktree's agy hooks before a start.
 * @throws {RepoHooksUntrusted} When the hooks file doesn't decode, or the main checkout has
 * `.codex/hooks.json` but the worktree has no agy hooks.
 * A permission problem while looking is reported as RepoHooksUntrusted naming the path.
 */
export const agyHookTrust = Effect.fn("agy.agyHookTrust")(function* (
  mainCheckout: string,
  worktree: string,
) {
  const hooksPath = yield* findAgyHooks(worktree).pipe(
    // The contract allows only RepoHooksUntrusted here; the detail already names the path.
    Effect.mapError((error) => new RepoHooksUntrusted({ detail: error.detail })),
  );
  if (hooksPath !== null) {
    yield* checkHooksFileDecodes(hooksPath);
    return { required: true } satisfies HookTrust;
  }
  if (yield* hasCodexHooks(mainCheckout))
    return yield* new RepoHooksUntrusted({
      detail: `${mainCheckout} has Codex hooks (${CODEX_HOOKS_FILE}) but no agy hooks (.agents/hooks.json) in ${worktree}; agy runs would skip the repo's guards. Add and commit .agents/hooks.json, then run foreman doctor.`,
    });
  return { required: false } satisfies HookTrust;
});
