/**
 * Codex repo hooks: whether a main checkout has `.codex/hooks.json`, and whether Codex trusts
 * the project hooks it loads for a worktree (`hooks/list`).
 */
import { Effect, FileSystem, Path, Schema } from "effect";
import { PermissionDenied, RepoHooksUntrusted } from "../../errors";
import * as Codex from "../../schemas/codex";

/** Anything that can send a Codex request; the app-server client in production and tests. */
export interface HooksClient<E> {
  readonly request: <A, I, R>(
    method: string,
    params: unknown,
    result: Schema.Codec<A, I, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Reports whether the main checkout has a Codex hooks file, dangling symlinks included.
 * @throws {PermissionDenied} When the hooks file's directory can't be inspected.
 * @throws {RepoHooksUntrusted} When inspecting the file fails for another reason.
 */
export const hasRepoHooks = Effect.fn("preflight.hasRepoHooks")(function* (mainCheckout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hookFile = path.join(mainCheckout, ".codex/hooks.json");
  // lstat includes dangling symlinks, which must fail closed too.
  return (
    (yield* fs.lstat(hookFile).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      Effect.mapError((error) =>
        error.reason._tag === "PermissionDenied"
          ? new PermissionDenied({
              detail: `Cannot inspect repo hooks at ${hookFile}. Check its directory permissions and retry.`,
            })
          : new RepoHooksUntrusted({
              detail: `Could not inspect repo hooks.\n${hookTrustFix(mainCheckout)}`,
            }),
      ),
    )) !== undefined
  );
});

/** The steps that make Codex trust a checkout's project hooks. */
export const hookTrustFix = (mainCheckout: string) =>
  `Open Codex in ${mainCheckout}, run /hooks and approve these hooks (and trust the project if Codex asks). Then run foreman doctor to check.`;

/**
 * Asks Codex which project hooks it loads for the worktree and whether each is trusted.
 * @throws E When the hooks/list request fails.
 */
export const inspectHookTrust = Effect.fn("preflight.inspectHookTrust")(function* <E>(
  client: HooksClient<E>,
  mainCheckout: string,
  worktree: string,
) {
  const params = yield* Schema.encodeEffect(Codex.HooksListParams)({ cwds: [worktree] });
  const response = yield* client.request(Codex.Method.hooksList, params, Codex.HooksListResponse);
  const entries = response.data.filter((entry) => entry.cwd === worktree);
  const hooks = entries.flatMap((entry) => entry.hooks).filter((hook) => hook.source === "project");
  const failures = hooks
    .filter((hook) => hook.trustStatus !== "trusted" && hook.trustStatus !== "managed")
    .map((hook) => `${hook.key}: ${hook.trustStatus}`);
  if (hooks.length === 0)
    failures.push(`Codex loaded no project hooks from ${mainCheckout}/.codex/hooks.json.`);
  for (const entry of entries)
    for (const error of entry.errors) failures.push(`${error.path}: hooks/list error`);
  return {
    hooks: hooks.map((hook) => ({ key: hook.key, status: hook.trustStatus })),
    acceptsStart: failures.length === 0,
    detail: failures.length === 0 ? null : `${failures.join("\n")}\n${hookTrustFix(mainCheckout)}`,
  };
});

/**
 * Refuses a start when the main checkout has repo hooks that Codex won't run in the worktree.
 * @throws {RepoHooksUntrusted} When a project hook is untrusted, missing or failed to load.
 * @throws {PermissionDenied} When the hooks file can't be inspected.
 * @throws E When the hooks/list request fails.
 */
export const checkHookTrust = Effect.fn("preflight.checkHookTrust")(function* <E>(
  client: HooksClient<E>,
  mainCheckout: string,
  worktree: string,
) {
  const present = yield* hasRepoHooks(mainCheckout);
  if (!present) return;
  const result = yield* inspectHookTrust(client, mainCheckout, worktree);
  if (!result.acceptsStart)
    return yield* new RepoHooksUntrusted({ detail: result.detail ?? undefined });
});
