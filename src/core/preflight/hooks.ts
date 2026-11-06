import { Effect, FileSystem, Path, Schema } from "effect";
import type { openConnection } from "../../codex/client";
import { PermissionDenied, RepoHooksUntrusted } from "../../errors";
import * as Codex from "../../schemas/codex";

type Connection = Effect.Success<ReturnType<typeof openConnection>>;

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

export const hookTrustFix = (mainCheckout: string) =>
  `Open Codex in ${mainCheckout}, run /hooks and approve these hooks (and trust the project if Codex asks). Then run forman doctor to check.`;

export const inspectHookTrust = Effect.fn("preflight.inspectHookTrust")(function* (
  connection: Connection,
  mainCheckout: string,
  worktree: string,
) {
  const params = yield* Schema.encodeEffect(Codex.HooksListParams)({ cwds: [worktree] });
  const response = yield* connection.request(
    Codex.Method.hooksList,
    params,
    Codex.HooksListResponse,
  );
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

export const checkHookTrust = Effect.fn("preflight.checkHookTrust")(function* (
  connection: Connection,
  mainCheckout: string,
  worktree: string,
) {
  const present = yield* hasRepoHooks(mainCheckout);
  if (!present) return;
  const result = yield* inspectHookTrust(connection, mainCheckout, worktree);
  if (!result.acceptsStart)
    return yield* new RepoHooksUntrusted({ detail: result.detail ?? undefined });
});
