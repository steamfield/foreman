/**
 * agy's repo hooks: where a worktree's `hooks.json` lives and whether a start can trust it.
 * agy loads workspace hooks with no trust step and reports no hook runs over ACP, so foreman
 * checks the file decodes and refuses repos whose guards exist only for Codex.
 */
import { Effect, type FileSystem } from "effect";
import type { PermissionDenied, RepoHooksUntrusted } from "../../errors";
import type { HookTrust } from "../contract";

/** The directories agy reads workspace hooks from, in its precedence order. */
export const AGY_HOOK_DIRS = [".agents", ".agent", "_agents", "_agent"] as const;

/**
 * Returns the first `hooks.json` agy would load from the worktree, or null when there is none.
 * A dangling symlink counts as present.
 * @throws {PermissionDenied} When a hook directory can't be inspected.
 */
export const findAgyHooks = (
  _worktree: string,
): Effect.Effect<string | null, PermissionDenied, FileSystem.FileSystem> =>
  Effect.die(new Error("not implemented"));

/**
 * Checks the worktree's agy hooks before a start.
 * @throws {RepoHooksUntrusted} When the hooks file doesn't decode, or the main checkout has
 * `.codex/hooks.json` but the worktree has no agy hooks.
 */
export const agyHookTrust = (
  _mainCheckout: string,
  _worktree: string,
): Effect.Effect<HookTrust, RepoHooksUntrusted, FileSystem.FileSystem> =>
  Effect.die(new Error("not implemented"));
