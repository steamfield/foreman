# Plan: providers and the agy provider

Skill: deliver. Profile: deliver. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/shared/scripts/plan_graph.py
Started: 2026-11-22. Timebox: none. Landing branch: deliver/agy-provider.
Gate: `bun run check` (about 300s: lint, typecheck, 180s unit suite, e2e). Filtered tests: `bun run test:unit <file or name filter>`. Typecheck: `bun run typecheck`.
Runner: plain commands.
Worktree setup: `ln -sfn /Users/riley/Projects/claude-codex/node_modules node_modules`
Manifests: bun.lock

Design: docs/rfcs/0002-providers.md (reviewed). Plan phases map to RFC phases as: plan 0 and 1 are RFC phase 0 (split because the supervisor switch can't start until the Codex adapter and shared seams exist), plan 2 is RFC phase 1, plan 3 is RFC 2, plan 4 is RFC 3, plan 5 is RFC 4.

Finish: after approval was given up front by the user ("execute end to end"), merge to main, push, and cut 0.4.0 per AGENTS.md Releasing.

## Spec

foreman delegates to Codex or agy (Antigravity CLI over ACP), chosen by the model Claude names. Every run command works the same for both providers. The RFC is the spec; this plan adds lanes, contracts and test cases.

In scope: everything in RFC 0002 Design and Phases.
Out of scope: RFC "Out of scope" list; any change to Codex behavior in plan phases 0 and 1.
Assumptions: agy 1.5.14 wire behavior as recorded in the RFC probe tables; Codex 0.169.0.
Error model: RFC "Errors" section. Provider failures are `CodexUnavailable` or `AgyUnavailable` (exit 5, retryable); routing failures `ModelUnresolved` (exit 2); transport errors `RpcError` and `RpcRequestTimeout` stay internal and are mapped at the supervisor boundary (`rejectRequest` in src/supervisor/index.ts) as `CodexRpcError` and `CodexRequestTimeout` are today.

## Contracts (scaffold commit)

Committed in the phase 0 scaffold: `src/schemas/provider.ts` (ProviderId, Access), `src/providers/contract.ts` (Provider, ProviderConnection, ProviderEvent, Inbound, QuestionCall, SteerRefused, ...), `src/providers/jsonrpc.ts` (stub: Channel, openChannel, RpcError, RpcRequestTimeout, ChannelEnd), `AgyUnavailable` in `src/errors.ts`.

Layout after plan phase 1:

    src/
      providers/
        contract.ts          provider types; no I/O
        jsonrpc.ts           NDJSON JSON-RPC over child stdio
        codex/
          events.ts          Codex notification -> Inbound (pure decode, per-turn item tracking for hand-off)
          connection.ts      ProviderConnection for Codex over a jsonrpc Channel
          questions.ts       item/tool/call -> QuestionCall
          hooks.ts           .codex/hooks.json presence and hooks/list trust
          catalog.ts         models_cache.json default model
          check.ts protocol.ts environment.ts   moved from src/codex/
          provider.ts        Provider for Codex; wiring only
      supervisor/
        connections.ts       one lazily started connection per provider (was app-server.ts)
        notifications.ts     applies ProviderEvents to a run; no wire decoding

## Phases

### Phase 0: shared seams and the Codex event decoder (additive)

Demo: `bun run check` passes; nothing user-visible changes; `tests/providers/codex-events.test.ts` and `tests/providers/jsonrpc.test.ts` pass.
Scaffold: b40302a1339a4c93f30549415567a384daed1b50
Tag: phase-0

Test cases (owned and written by the lanes, from the lists in each brief).

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/providers/jsonrpc.ts, src/codex/client.ts, tests/providers/jsonrpc.test.ts, tests/fixtures/jsonrpc/ | contracts, src/codex/client.ts, tests/codex-client.test.ts | tests/codex-client.test.ts | opus | merged | deliver/agy-provider-0a | jsonrpc and codex-client tests pass |
| b | M | src/providers/codex/events.ts, src/providers/codex/events-items.ts, tests/providers/codex-events.test.ts | contracts, src/supervisor/notifications.ts, src/core/runs/normalize.ts | tests/run-normalize.test.ts | opus | merged | deliver/agy-provider-0b | codex-events tests pass |
| c | M | src/schemas/daemon.ts, src/core/runs/store.ts, src/config.ts, src/daemon/client.ts, src/daemon/server.ts, src/core/commands.ts, .env.example, README.md, tests/provider-storage.test.ts, tests/config-logging.test.ts | contracts, docs/acceptance/typescript-cli.md | tests/daemon-ownership.test.ts | sonnet | merged | deliver/agy-provider-0c | provider-storage and config tests pass |

#### Lane a brief

- Goal: implement `openChannel` in `src/providers/jsonrpc.ts` by extracting the generic transport from `src/codex/client.ts`, then rewrite `openConnection` in `src/codex/client.ts` as a thin Codex layer over it. Behavior of `openConnection` is unchanged.
- Interface: the scaffold's `jsonrpc.ts` signatures exactly (`openChannel`, `Channel`, `ChannelOptions`, `ChannelEnd`, `RequestOptions`, `RpcError`, `RpcRequestTimeout`, `RpcId`, `RpcNotification`, `RpcServerRequest`). `src/codex/client.ts` keeps exporting `openConnection`, `ConnectionOptions`, `CodexRpcError` and `CodexRequestTimeout` with today's shapes so the supervisor compiles untouched; `CodexRpcError`/`CodexRequestTimeout` stay their own classes and `openConnection` maps `RpcError`/`RpcRequestTimeout` to them, so no `_tag` changes.
- Behavior (all as today's client.ts): one JSON object per line on stdin; lines decoded as response, notification (method, no id) or server request (method and id); responses matched to pending requests by id, late responses ignored; request timeout default 30 s, `"none"` waits for the channel's life; timeout fails with `RpcRequestTimeout` and removes the pending entry; launch failure, stdin/stdout/stderr failure, invalid JSON line, and child exit each end the channel through `unavailable(end)` with the same detail strings as today ("app server stdin failed", "invalid app server JSON-RPC message", "app server exited with code N", ...) — pass these as `ChannelEnd.Failed.detail` from Codex's `unavailable`; a deliberate scope close is `ChannelEnd.Closed` (replaces the "app server connection closed" detail comparison; `openConnection` maps Closed to `CodexUnavailable({detail: "app server connection closed"})` so `app-server.ts:92` keeps working); pending requests fail with the end cause; notification and server-request queues end or fail with it; reader and stderr fibers joined with the 2 s bound after exit; `forceKillAfter: "2 seconds"`; `extendEnv: false`; `cwd` passed to the spawn when given. Codex param encoding (`paramsSchemas`) stays in client.ts and runs before `channel.request`; `initialize`/`initialized` stay in client.ts.
- jsonrpc.test.ts cases, against a tiny scripted child (a Node one-liner or a fixture under tests/fixtures/jsonrpc/, owned by you): request/response round trip; string and numeric ids; error response becomes RpcError with code and message; timeout yields RpcRequestTimeout and a late reply is ignored; `"none"` timeout waits past 30 s on TestClock; notifications and server requests are routed and buffered before consumption; invalid line ends the channel with Failed; child exit ends it with Failed naming the exit code and fails pending requests; scope close yields Closed and no Failed; launch of a missing executable fails with `unavailable(Failed)`; cwd is applied.
- Decisions already made: no retries; no request queueing beyond today's.
- Out of scope: any supervisor, app-server.ts or schema change; moving files under src/codex/ (plan phase 1 does).
- Done when: `bun run test:unit tests/providers/jsonrpc.test.ts tests/codex-client.test.ts` and `bun run typecheck` pass, with tests/codex-client.test.ts unchanged.

#### Lane b brief

- Goal: a pure Codex decoder, `src/providers/codex/events.ts`, that turns one Codex app-server notification into the contract's `Inbound`, reproducing exactly what `src/supervisor/notifications.ts` (decode, minimal fallbacks, method filters, hook kind check) and `src/core/runs/normalize.ts` (event normalization, `pickHandoff`, `outputTail`) do today. Nothing calls it yet; plan phase 1 switches the supervisor to it.
- Interface:
  - `export interface CodexTurnItems { readonly items: readonly ThreadItem[] }` per session, owned by the caller (plan phase 1 keeps one per session in the connection).
  - `export function decodeNotification(message: RpcNotification, items: CodexTurnItems): { inbound: Inbound; items: CodexTurnItems }` — pure; returns the updated item list (append completed items; reset on `turn/started`).
  - `export function pickHandoff(items: readonly ThreadItem[]): string | null` and `outputTail` moved here (normalize.ts keeps `contractTitle` and re-exports nothing; leave normalize.ts itself untouched in this lane: plan phase 1 deletes the moved functions there).
- Behavior, method by method, for a message whose params carry `threadId` (session = threadId; else session null):
  - `turn/started`, `turn/completed`: full TurnNotification decode, else TurnNotificationMinimal plus `DecodeIssue{issue:"minimal"}`, else `DecodeIssue{issue:"invalid"}` only. Status normalized as `turnStatus` does (unknown statuses become `failed`). `turn/started` emits `TurnStarted{turn}`. `turn/completed` emits `TurnCompleted{turn, status, failure: turn.error, handoff: pickHandoff([...items, ...turn.items])}` and a `AgentMessage` is not emitted here (items already produced them).
  - `item/started`: minimal envelope decode (`ItemNotificationMinimal`) gives `turn` and `id`; `ItemKind` gives the type; emit `ItemStarted{turn, id, kind, type, command}` where kind is `command` for `commandExecution`, `fileChange` for `fileChange`, `agentMessage` for `agentMessage`, `tool` for `dynamicToolCall`/`mcpToolCall`, `other` otherwise; command from a full decode when it succeeds, else null. If the full decode fails, also `DecodeIssue{issue:"invalid"}`. If even the minimal decode fails, emit only `DecodeIssue{invalid}` with turn null.
  - `item/completed`: full decode. commandExecution → `ItemCompleted{command, status, exitCode, outputTail}`; fileChange → `ItemCompleted{fileChange, paths}`; agentMessage → `AgentMessage{text, phase}` (phase `final_answer`/`commentary`/null: map any other string to null) ; subAgentActivity → `SubAgent{activity}` ; others → `ItemCompleted{other, type}`. Completed items are appended to `items`.
  - `hook/started` → `HookStarted{turn, project: source === "project"}`; `hook/completed` with status `blocked` → `HookBlocked{event, feedback}` (entries joined by newline), otherwise nothing.
  - `thread/tokenUsage/updated` → `TokenUsage{turn, totals}` from `total` as normalize.ts maps it.
  - `error` with `willRetry` → `Retrying{turn, message}`; without → nothing.
  - `mcpServer/startupStatus/updated` with status `failed` → `McpStartupFailed{server, error}`; else nothing. Its threadId may be null.
  - Methods ending `/delta`, `item/commandExecution/outputDelta`, `turn/moderationMetadata`, `turn/diff/updated` → `Activity`.
  - Any other method → `Unrecognized{method}`.
  - Every `Inbound` carries `method` and `raw` (the message).
- Test cases (port every case from tests/run-normalize.test.ts for normalize/pickHandoff/outputTail, which stays read-only and must keep passing), plus: each method above, the minimal fallback for turn and item notifications, item/started with an undecodable item still yielding kind `command`, unknown turn status → failed, delta methods → Activity, unknown method → Unrecognized, null threadId → session null, items reset on turn/started and used for the hand-off.
- Out of scope: supervisor changes, Codex request sending, questions (item/tool/call).
- Done when: `bun run test:unit tests/providers/codex-events.test.ts tests/run-normalize.test.ts` and typecheck pass.

#### Lane c brief

- Goal: the storage, config and daemon-handshake pieces every later phase needs, with no behavior change for Codex runs.
- Interface and behavior:
  - `src/schemas/daemon.ts`: `RunRecord` gains `provider: Schema.optionalKey(ProviderId)` (absent = codex); `StorageHeader.formatVersion` accepts 1, 2 and 3; `Digest` gains `provider: Schema.optionalKey(ProviderId)`; `RunEventBody` gains `Permission: {kind: Schema.String, title: Schema.String, decision: Schema.Literals(["approved","rejected"])}`; `Pong` gains optional `agyBin`; export `providerOf(record): ProviderId`.
  - `src/core/runs/store.ts`: `writeRun` and `createRun` write `formatVersion` 3 when `providerOf(record) === "agy"`, else 1 (derive it; no default parameter left for run.json writes); a `rawLogName(provider)` (`codex.jsonl` / `agy.jsonl`) used by the version checks at store.ts:115 and :121 (check both names); `appendProviderMessage(runDir, provider, message)` writing to the provider's log with today's redaction and rotation; keep `appendCodexMessage` as a one-line call to it for now.
  - `src/config.ts`: `agyBin` from `AGY_BIN`, then config.json `agyBin`, default `agy`, resolved like `codexBin`; config.json also accepts `defaultModel` (non-empty string, exposed as `defaultModel: string | null`); `inDelegate` true when any of `CODEX_DELEGATE`, `AGY_DELEGATE` is set. Unknown-key diagnosis lists the new keys. Add the precedence tests the acceptance matrix asks for in tests/config-logging.test.ts and entries in `.env.example` and README's configuration table.
  - Daemon handshake: the server's Pong reports `agyBin`; the client's replacement check (`client.ts:435-440`) treats a differing `agyBin` like a differing `codexBin`; `src/core/commands.ts` passes `agyBin` where it passes `codexBin`.
- Test cases (tests/provider-storage.test.ts): an agy record round-trips with formatVersion 3 through createRun, writeRun and recovery's transition replay; a codex record and a record without `provider` write version 1 and read back as codex; a version 4 run.json is refused as unsupported; raw messages for an agy run land in agy.jsonl and its version header is checked; `Permission` events round-trip. Config: AGY_BIN beats config.json beats default; `defaultModel` validation; AGY_DELEGATE sets inDelegate.
- Out of scope: the supervisor writing `provider` (it doesn't yet), any routing.
- Done when: `bun run test:unit tests/provider-storage.test.ts tests/config-logging.test.ts tests/daemon-ownership.test.ts` and typecheck pass.

### Phase 1: the supervisor on the provider contract

Demo: `bun run check` passes with the behavior tests unchanged (RFC Testing section); `FOREMAN_SMOKE=1 bun run smoke` passes against real Codex.
Depends on: phase 0
Scaffold: 53eadd802dce5f0d9a12aa323f0a173623de7935
Tag: agy-phase-1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | src/supervisor/, src/providers/codex/, src/codex/, src/core/runs/normalize.ts, src/core/preflight/hooks.ts, src/core/preflight/model.ts, src/core/doctor.ts, src/core/runs/store.ts, src/commands/monitor.ts, biome-plugins/boundaries.grit, tests/supervisor-integration.test.ts, tests/run-normalize.test.ts, tests/codex-client.test.ts, tests/preflight-hooks.test.ts, tests/preflight-model.test.ts, tests/fixtures/daemon/entry.ts | contracts, docs/architecture.md | tests/cli.test.ts, tests/daemon-lifecycle.test.ts, tests/monitor-feed.test.ts | opus | merged | deliver/agy-provider-1a | full gate green |

#### Lane a brief

- Goal: the supervisor drives runs only through `ProviderConnection` and `ProviderEvent` (src/providers/contract.ts), with Codex as the one provider. User-visible behavior, daemon protocol, stored files, error tags and every message string stay exactly as today. RFC sections "The provider contract" and "What moves where" are the design.
- Codex provider (`src/providers/codex/`):
  - Move `src/codex/check.ts`, `protocol.ts`, `environment.ts` and `client.ts` here (client.ts becomes `connection.ts` or stays `client.ts` under this directory; your call), `src/core/preflight/hooks.ts` to `hooks.ts`, `src/core/preflight/model.ts` to `catalog.ts`. Delete `src/codex/`. `src/schemas/codex.ts` stays where it is.
  - `connection.ts`: `connectCodex(...)` returns a `ProviderConnection` (provider `"codex"`). `open` is today's `thread/start` (180 s timeout, `dynamicTools: [askOrchestratorTool]`, settings from `SessionSettings`: sandbox `read-only` for access read-only, `danger-full-access` for write, approvalPolicy never, serviceTier from `tier`) followed by `thread/name/set`, whose refusal or timeout becomes `Opened.warnings` with today's text. `resume` is `thread/resume` and returns `{sandbox: resumed.sandbox.type, model}`. `isLoaded` reads the loaded-thread set (open and resume add to it). `startTurn` is `turn/start` with `effort` and `sandboxPolicy` (read-only, network off, when `kind === "handoff"` or access is read-only; dangerFullAccess otherwise). `steer` is `turn/steer` with `expectedTurnId`; an `RpcError` becomes `SteerRefused{reason: error.message}`. `interrupt` is `turn/interrupt`. `hookTrust` is today's `checkHookTrust` (it returns `{required}` from `hasRepoHooks` and fails `RepoHooksUntrusted` as today). `inbound` maps channel notifications through `decodeNotification` (src/providers/codex/events.ts, from phase 0) with one `CodexTurnItems` per session. `questions` maps `item/tool/call` server requests through `questions.ts`: unsupported tool → respondError(-32601, "unsupported tool"); invalid args → respondError(-32602, "invalid ask_orchestrator arguments"); unknown method → respondError(-32601, "unsupported method"); otherwise a `QuestionCall` whose `respond` sends `{success: true, contentItems: [{type: "inputText", text}]}`, `reject` sends respondError(-32602, reason), and `cancel` sends nothing.
  - `provider.ts`: the Codex `Provider` (capabilities `{serviceTier: true, hookEvents: true}`, environment from today's `appServerEnvironment` with the SSH probe, `compatibilityWarning` from today's protocol check with today's text, `connect`).
- Supervisor:
  - `app-server.ts` becomes `connections.ts`: today's lifecycle (lazy start, generation, retire, stderr redaction into logs/app-server.log, loss handling, the deliberate-close case) per provider, with `get(provider)`, `forRun(run)` (provider from `providerOf(run.record)`), `retire`, `compatibilityWarning(provider)`, `warnings`, `environment(provider)`. Only Codex is registered in this phase.
  - `notifications.ts` applies one `Inbound` to a run under the run lock, in today's order: activity clock and wake after silence; append `raw` with `Store.appendProviderMessage`; unknown-state turn adoption (from the first event with a turn); the hook rule on `ItemStarted` with kind `command` when the provider's `capabilities.hookEvents` and `run.hooksRequired` hold and no project `HookStarted` was seen this turn (same interrupt, failure text and state handling as today); `DecodeIssue` → the same per-run warning text, with the provider's display name ("Codex"); `Unrecognized` → `Other{method}` event; the stale-turn filter (drop events whose non-null `turn` differs from `activeTurnId`); budget arming; persisted `RunEventBody`s from a pure `toRunEvents(event, turnNumber, turnKind)` in a new `src/supervisor/run-events.ts` matching today's normalizeNotification output exactly; then the per-event state handling (TurnStarted, TurnCompleted with `handoff` from the event, ItemStarted openItem, ItemCompleted closing openItem, AgentMessage commentary when phase isn't `final_answer`, SubAgent folding, HookStarted project flag).
  - `questions.ts` receives `QuestionCall`s: the turn check (call.turn vs activeTurnId and running/waiting state) rejects with `call.reject("turn is no longer active")`; `Run.calls` holds `{call, generation}`; `resolve` answers through `call.respond` with today's generation check; `cancelQuestions` (registry) also runs `call.cancel` for each held call it cancels.
  - `turns.ts` and `index.ts` call the run's connection (`connections.forRun(run)` everywhere `servers.get` is used today); `SteerRefused` maps to today's RunConflict texts (`activeTurnNotSteerable for run ...` when the reason is `activeTurnNotSteerable`, else `Codex refused the steer for run ...`), so answer's fallback is unchanged. `RpcError`/`RpcRequestTimeout` replace `CodexRpcError`/`CodexRequestTimeout` in every `instanceof` and mapping, producing today's strings. Routing uses `Inbound.session` / `QuestionCall.session` against `record.threadId`.
  - `registry.ts`: drop `Run.items` (the adapter tracks turn items); `Run.calls` type changes as above.
  - Start does not write `provider` for Codex runs (absent means codex), so 0.3.1 can still read them.
- `src/core/runs/normalize.ts` keeps only `contractTitle`; tests of the moved functions live in tests/providers/codex-events.test.ts already, so remove them from tests/run-normalize.test.ts.
- Boundary rule in biome-plugins/boundaries.grit: `schemas/codex` imported under `src/` only from `src/providers/codex/` (diagnostic: "Codex wire types stay in src/providers/codex; use the provider contract."). Same for the jsonrpc wire types: `src/supervisor/` must not import `schemas/codex`.
- Tests: behavior tests stay unchanged (cli, daemon-lifecycle, monitor-feed and the rest of the suite). In tests/supervisor-integration.test.ts rewrite only the internal call sites (makeAppServer around :375, :3376, :3636; raw `questions.receive` around :4940-5128; `CodexRpcError` references) against `connections.ts`/`QuestionCall`, keeping each test's case and expectation. Import-path edits only in tests/codex-client.test.ts, tests/preflight-hooks.test.ts, tests/preflight-model.test.ts, tests/fixtures/daemon/entry.ts and src/commands/monitor.ts.
- Out of scope: any agy code, provider routing by model, Permission events, writing `provider` to run.json.
- Done when: `bun run check` passes in your worktree (the full gate is allowed for this lane because it is the only lane in the phase) and the list of test names in tests/supervisor-integration.test.ts is unchanged (`grep -c "it\.\|it(" ` before and after match).

### Phase 2: an agy turn end to end

Demo: with AGY_BIN pointing at real agy, `foreman start agy-hello --model gemini-4-neon --new-worktree --write --contract hello.md --wait` creates a file and returns the hand-off; `result`, `status`, `events`, `interrupt`, `followup` and `archive` work on that run; the same start with `--model gemini-3.8-flash` and no `--write` refuses an edit, records a `Permission` event and reports the run failed with the refusal message; an agy start in a repo with `.codex/hooks.json` and no `.agents/hooks.json` is refused.
Depends on: phase 1

Scaffold (written when phase 1 lands): `src/providers/output-tail.ts` (outputTail moved out of the Codex decoder), `src/providers/environment.ts` (shared env filter used by both providers), stubs for every lane-b export and for `src/providers/agy/provider.ts` and `src/providers/routing.ts`, `provider` on the daemon `Start` request, the fake ACP agent (landed), and the phase test `tests/agy-runs.test.ts`, which drives real daemon runs against the fake ACP agent: a write turn ending idle with hand-off, events (Command, FileChange, AgentMessage, TokenUsage, Permission approved), result and status digests showing provider agy; a read-only run whose edit is refused ending failed with the refusal text and a `Permission` rejected event; interrupt of a long command ending interrupted; followup on the same session; archive; a start refused for Codex-only hooks; a start refused for ACP protocol 2; a run.json with formatVersion 3 and provider agy.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/schemas/acp.ts, src/providers/jsonrpc.ts, src/providers/agy/launch.ts, src/providers/agy/live.ts, src/providers/agy/permission-requests.ts, src/providers/agy/connection.ts, src/providers/agy/events.ts, src/providers/agy/turns.ts, src/providers/agy/provider.ts, tests/providers/agy-connection.test.ts, tests/acp-schemas.test.ts | contracts, src/providers/codex/connection.ts | tests/agy-runs.test.ts | opus | merged | deliver/agy-provider-2a | agy-connection and acp-schemas tests pass |
| b | S | src/providers/agy/permissions.ts, src/providers/agy/hooks.ts, src/providers/agy/catalog.ts, src/providers/agy/environment.ts, tests/providers/agy-policy.test.ts, tests/providers/agy-hooks.test.ts, tests/providers/agy-catalog.test.ts | contracts | | sonnet | merged | deliver/agy-provider-2b | agy-policy tests pass |
| c | M | src/providers/routing.ts, src/providers/codex/catalog.ts, src/supervisor/read-only-check.ts, src/supervisor/registry.ts, tests/read-only-changes.test.ts, src/supervisor/connections.ts, src/supervisor/turns.ts, src/supervisor/notifications.ts, src/core/runs/digest.ts, src/core/commands.ts, src/commands/runs.ts, src/daemon/client.ts, tests/provider-routing.test.ts | contracts | tests/agy-runs.test.ts | opus | merged | deliver/agy-provider-2c | provider-routing tests pass; agy-runs passes once lane a lands |
| d | S | .agents/hooks.json, .agents/hooks/, tests/hooks/agy-adapter.test.ts | .claude/hooks/block-destructive.sh, .claude/hooks/detect-secrets.sh | | sonnet | merged | deliver/agy-provider-2d | agy-adapter tests pass |

Scaffold: 1333521
Tag: agy-phase-2

#### Amendments after the phase 1 boundary fixes (apply to every lane below)

- The contract changed (src/providers/contract.ts): `Provider` extends `ProviderDescriptor` (id, displayName, binary, capabilities, environment, compatibilityWarning, defaultModel, unavailable, hasRepoHooks(mainCheckout, worktree), hookBypassMessage) and has no type parameter; a provider captures only FileSystem, Path and ChildProcessSpawner when built (never a Scope), as src/providers/codex/provider.ts does. `ProviderConnection` gained `ask(session, ExternalQuestion)`. `Inbound.raw` may be null (nothing logged). `turn: null` on an event means "unnamed, applies to the active turn"; a message that belongs to no turn is an Inbound with `events: []`.
- Shared helpers in the scaffold: `providerEnvironment(inherited, ssh, drop, markers)` in src/providers/environment.ts (Codex's `appServerEnvironment` uses it), `outputTail` in src/providers/output-tail.ts. The daemon `Start` body has an optional `provider`.
- tests/agy-runs.test.ts and tests/helpers/agy.ts are the scaffold's phase test and are read-only to lanes. They fail until lanes a, b and c land.
- Lane a: `makeAgyProvider(options)` in provider.ts replaces the stub with the real descriptor: environment = `agyEnvironment(inherited, yield* probeSsh(inherited))` cached; compatibilityWarning from the agent version vs `supportedAgy.version`; defaultModel "gemini-4-neon"; `hasRepoHooks` = `findAgyHooks(worktree) !== null`, mapping PermissionDenied through and nothing else; hookBypassMessage is never called for agy (hookEvents false) but returns a sensible sentence. `ask` refuses with `QuestionRefused{reason: "agy questions arrive in a later foreman version"}` until phase 3. Push `TurnStarted` with `raw: null`. A `session/update` with no prompt outstanding becomes `{session, method, raw, events: []}`, not null-stamped events.
- Lane b: `agyEnvironment` uses `providerEnvironment`. `agyHookTrust` fails only with RepoHooksUntrusted (a PermissionDenied while looking becomes RepoHooksUntrusted naming the path).
- Lane c also owns src/providers/codex/catalog.ts (add the listed Codex model ids routing needs) and src/schemas/daemon.ts only if routing needs it. Register agy in `makeProviders` (src/supervisor/connections.ts) with stderrLog "logs/agy-stderr.log" and `home` = config's foreman home; Start uses `body.provider ?? "codex"` for the run record, `requestFailure` and the provider lookup (replacing the NEW_RUN_PROVIDER constant).

#### Lane a brief

- Goal: the agy `ProviderConnection` over `agy acp`, as RFC "The agy adapter" describes, minus questions (phase 3), steering and resume (phase 4).
- Interface: `src/providers/agy/provider.ts` exports `agyProvider(config)` returning a `Provider` (capabilities `{serviceTier: false, hookEvents: false}`, environment from lane b's `agyEnvironment`, `compatibilityWarning` from the last `initialize` reply's agent version vs `supportedAgy.version` "1.5.14", `connect`). `connection.ts` builds the connection over `openChannel` (src/providers/jsonrpc.ts) with `unavailable` producing `AgyUnavailable` with agy wording ("agy exited with code N", "could not launch agy (<reason>). Install agy or set AGY_BIN, then run foreman doctor."). `turns.ts` holds the per-session turn state machine as pure functions (outstanding prompts, turn id, message buffer, refusal, usage sum) so it's testable without a child. `events.ts` maps `session/update` to `ProviderEvent`s (pure). `src/schemas/acp.ts` declares only the fields foreman reads, decoding unknown fields leniently like schemas/codex.ts.
- Behavior:
  - Spawn `<agyBin> acp --disable-telemetry --log-file <home>/logs/agy-acp.log` with process cwd `<home>/providers/agy/cwd` (create it), the provider environment, `extendEnv: false`. stderr goes to the same redacted log path the Codex child uses for its stderr, `logs/agy-stderr.log`.
  - `initialize` (60 s): `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo: {name: "foreman", version}}`. A reply with `protocolVersion` other than 1 fails the connection with AgyUnavailable "agy speaks ACP protocol N; foreman supports 1. Install agy 1.5.14 or a compatible version, then run foreman doctor."
  - `open`: `session/new {cwd, mcpServers: []}` (180 s timeout); then `session/set_config_option {sessionId, configId: "model", value}` where value is `settings.model` when it already ends with `-<settings.effort>`, else `<model>-<effort>`; then `session/set_mode {sessionId, modeId: "default"}`. A JSON-RPC error whose message mentions authentication fails with AgyUnavailable "agy isn't signed in. Run agy once and sign in, then run foreman doctor."; other errors stay RpcError. `title` is unused (agy titles sessions itself).
  - `startTurn`: turn id `t<request.turn>`; record the session's access and turn kind for the permission policy; push `TurnStarted` onto inbound; send `session/prompt {sessionId, prompt: [{type: "text", text: input}]}` with timeout `"none"` on a fiber in the connection's scope; return the turn id. When the reply arrives: emit (in this order) `AgentMessage{phase: "final_answer"}` with the hand-off text if any, `TokenUsage` with run totals summed across the session's replies (inputTokens, cachedReadTokens as cachedInput, outputTokens, thoughtTokens as reasoningOutput), and `TurnCompleted{status, failure, handoff}`. Status: end_turn completed, cancelled interrupted, anything else failed with failure message "agy stopped the turn: <stopReason>". A recorded refusal makes the turn failed with the refusal message (lane b's `refusalMessage`). A JSON-RPC error reply makes it failed with "agy refused the turn: <message>" (auth wording as above).
  - Events from `session/update` (RFC events table): stamped with the turn of the outstanding prompt, null when none is outstanding. Hand-off text is the agent message text after the turn's last tool call, else all of it. Commentary (`AgentMessage{phase: "commentary"}`) is the buffered text since the previous tool call, emitted when the next tool call starts.
  - `session/request_permission` server requests: decide with lane b's `decidePermission`, answer `{outcome: {outcome: "selected", optionId}}` with the option lane b's `pickOption` returns, emit `Permission{turn, kind, title, decision}` on inbound, and on a rejection record the refusal for the turn. A request for an unknown session is rejected the same way. Other server requests (fs/*, terminal/*) get error -32601.
  - `interrupt`: notify `session/cancel {sessionId}`, then wait up to 30 s for the outstanding prompts to reply; on timeout fail with `RpcRequestTimeout{method: "session/cancel"}`.
  - `steer`: fail `SteerRefused{reason: "agy steering is not available yet"}`. `resume`: fail AgyUnavailable "Resuming an agy session after a daemon restart isn't available yet; start a new run." (phase 4 replaces both). `isLoaded`: sessions opened on this connection. `questions`: an empty stream. `hookTrust`: lane b's `agyHookTrust`.
- Tests: acp-schemas.test.ts decodes every line of tests/fixtures/agy-1.5.14.jsonl that foreman reads. agy-connection.test.ts drives the connection against tests/fixtures/fake-acp-agent (scenarios.ts builders): open sends the three requests with the right params (FAKE_ACP_LOG), protocol 2 refused, write turn event sequence and hand-off, refused edit ends failed with the refusal text, cancel ends interrupted, cancel timeout fails, stamping null when no prompt is outstanding, unknown server request gets -32601, child exit fails with agy wording, missing binary fails with the install hint.
- Out of scope: MCP question bridge, steering, resume, routing, the supervisor.

#### Lane b brief

- Goal: the pure policies and small I/O helpers the agy connection and routing need.
- `permissions.ts`: `decidePermission({kind, name, access, turnKind, known}): "approved" | "rejected"` per RFC Permissions table (ask_orchestrator is `name === "mcp_foreman_ask_orchestrator"`: allowed except in hand-off turns; execute: allowed everywhere; edit/delete/move: allowed only for write access outside hand-off; other kinds allowed; unknown session rejected). `pickOption(options, decision)`: the first option of kind `allow_once` for approved, `reject_once` for rejected; when that kind is missing, approved falls back to rejected's choice and rejected to any `reject_*`; never `allow_always`; returns null if nothing fits (the caller then answers `{outcome: {outcome: "cancelled"}}`). `refusalMessage(title, kind, turnKind)`: "foreman refused <title> (<kind>) in a read-only run; agy ends a turn when a permission is refused. Follow up with narrower instructions or start a write run." (hand-off turns say "in the budget hand-off turn" instead of "in a read-only run").
- `hooks.ts`: `findAgyHooks(worktree)` returns the first existing `hooks.json` under `.agents/`, `.agent/`, `_agents/`, `_agent/` (lstat, so a dangling symlink counts; PermissionDenied becomes the PermissionDenied error with the path). `agyHookTrust(mainCheckout, worktree): {required}`: found → read and decode against agy's hook schema (top level record of name → object whose optional `enabled` is boolean and whose event keys hold arrays of `{matcher?: string, hooks: [{type: "command", command: string, timeout?: number}]}`); unreadable or not matching → RepoHooksUntrusted "agy can't load <path>: <reason>. Fix the file, then run foreman doctor."; not found but `<mainCheckout>/.codex/hooks.json` exists → RepoHooksUntrusted with the RFC message naming the worktree; otherwise `{required: false}`.
- `catalog.ts`: `parseAgyModels(stdout)` for `agy models` output (`<id>\t<name>` lines after an optional "Fetching..." line) into `{id, family, effort | null, name}` with effort from a `-low|-medium|-high|-xhigh` suffix (`gpt-oss-120b-medium` keeps family = id, effort "medium"); `readAgyCatalog({agyBin, env, home, now, refresh})` that returns the cached catalog at `<home>/providers/agy/models.json` (`{fetchedAt, agyVersion, models}`) unless missing, older than 24 h, the version from `agy --version` differs, or `refresh` is true; refreshing runs `agy models` (30 s timeout) and writes the cache via temp file and rename. Failures are AgyUnavailable with the command and its stderr tail.
- `environment.ts`: `agyEnvironment(inherited, ssh)` using the scaffold's shared filter: drops the shared set plus GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GEMINI_BASE_URL, GOOGLE_GENAI_USE_ENTERPRISE, AGY_ADC_AUTH, ANTIGRAVITY_PROJECT_ID; adds STACKS_DELEGATE=1 and AGY_DELEGATE=1.
- Tests (agy-policy.test.ts): the permission table over every kind × access × turn kind; option picking including missing kinds; refusal texts; hooks found in each directory, dangling symlink, bad JSON, schema mismatch, Codex-only refusal, none; catalog parsing of the recorded `agy models` output (copy the RFC's model list), cache hit, stale, version change, forced refresh, atomic write; environment drops and markers.

#### Lane c brief

- Goal: route runs to agy and wire the agy provider into the daemon and CLI.
- `src/providers/routing.ts`: `resolveModel({model?, effort?, tier?}, catalogs)` returning `{provider, model, effort}`. Codex catalog: today's models_cache (src/providers/codex/catalog.ts). agy catalog: lane b's `readAgyCatalog`. Rules (RFC Model routing): `provider:model` picks that provider; an exact id in exactly one catalog; an agy id with an effort suffix splits into family + effort (`--effort` must agree, else Usage error naming both); no model → Codex default exactly as today. Unknown model, ambiguity, `--tier` on agy, invalid effort: a `Usage` error with the RFC's message text (phase 5 upgrades these to `ModelUnresolved` with near-miss suggestions). agy effort default "high"; agy record `tier` "n/a". The agy catalog is read only when the model isn't in Codex's catalog.
- CLI: `src/core/commands.ts` start resolves before contacting the daemon and sends `provider` (omitted for codex), model and effort on `Start`. `src/commands/runs.ts`: `--model` help says it accepts Codex or agy models and `provider:model`. `src/daemon/client.ts`: an outdated busy daemon gets no agy `Start` (DaemonUnavailable with the RFC text).
- Supervisor: `connections.ts` registers the agy provider; `turns.ts` start records `provider: "agy"` for agy runs, uses the run's provider for environment, compatibility warning and hook trust, and adds the warning "read-only on agy blocks agy's edit tools but not shell commands; use a Codex model when you need an enforced read-only sandbox." to read-only agy runs. `notifications.ts`: on `TurnCompleted` of an agy read-only run (or any agy hand-off turn), after `refreshWorktree`, new paths in `newInGitStatus` since the run started add the warning "read-only agy run changed files: <paths>" and make the turn failed with that message. `src/core/runs/digest.ts`: digest carries `provider`.
- Tests (provider-routing.test.ts): every routing rule and error text with fixture catalogs; outdated-daemon refusal; the CLI sends provider/model/effort (through tests/helpers/cli.ts). tests/agy-runs.test.ts (scaffold) must pass once lanes a and b land; you can't run it to green alone.

#### Lane d brief

- Goal: this repo's guards run for agy. Add `.agents/hooks.json` and an adapter script under `.agents/hooks/` so agy's PreToolUse for `run_command` goes through `.claude/hooks/block-destructive.sh`, and for `write_file`/`edit_file` through `.claude/hooks/detect-secrets.sh`, refusing (as the Codex wiring does) when a guard script is missing.
- agy's hook contract is documented in ~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md (input JSON on stdin with `toolCall: {name, args}`; output JSON with `decision`). The adapter translates agy input into the Claude-hook input those scripts read (`tool_name`, `tool_input.command` / `file_path` and content), and their deny output (or exit 2 with stderr) into agy's deny decision with the reason. Allow otherwise.
- Tests (tests/hooks/agy-adapter.test.ts, following tests/hooks/ patterns): a destructive command is denied with the guard's reason, a harmless command allowed, a credential-shaped write denied, a missing guard script denies, malformed input denies.
- Out of scope: changes to the guard scripts themselves; AGENTS.md/harness docs (phase 5 lane c updates them).

### Phase 3: questions on agy

Demo: RFC phase 2 demo.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/commands/mcp-question.ts, src/core/mcp-question.ts, src/daemon/client.ts, tests/mcp-question.test.ts | contracts | | opus | running | deliver/agy-provider-3a | |
| b | M | src/providers/agy/questions.ts, src/providers/agy/connection.ts, src/providers/agy/live.ts, src/supervisor/questions.ts, src/supervisor/notifications.ts, tests/agy-questions.test.ts, tests/agy-runs.test.ts | contracts | | opus | running | deliver/agy-provider-3b | |

Scaffold: 1d264ff

Scaffold contents: the daemon `Ask` request in src/schemas/daemon.ts (`{run: RunName, question, kind: "question" | "blocked", callId}` replying `{_tag: "AskAnswer", text}` or failing `RunConflict` with the refusal reason), its dispatch in src/supervisor/index.ts to `connections.forRun(run)` then `connection.ask(session, ...)`, mapping QuestionRefused to RunConflict(reason) and QuestionCancelled to RunConflict("question cancelled by the orchestrator: <reason>"); the hidden `mcp-question --run <name>` command registered in src/cli.ts calling a stub `runQuestionBridge` in src/core/mcp-question.ts; the phase test tests/agy-question-runs.test.ts (real daemon, fake ACP agent, and the real bridge spawned by the fake: add a fake-agent step `mcpCall: {server, tool, arguments, label}` that launches the session's stdio MCP server from `session/new` mcpServers and calls the tool, and `awaitMcpResult: label`): a question reaches `waiting`, `foreman answer` releases it and the run finishes with the answer in the tool result; `defer` and the question timeout deferral reply with the deferral text; killing the bridge child while held records the question cancelled, moves the run back to running, and a later answer is a late answer; an ask with no prompt outstanding gets "turn is no longer active"; a hand-off turn's ask is refused by the permission policy.

#### Lane a brief (the bridge)

- Goal: `foreman mcp-question --run <name>` is a stdio MCP server exposing `ask_orchestrator` with exactly the input schema Codex gets (src/schemas/codex.ts `askOrchestratorTool`), forwarding each call to the daemon `Ask` request.
- Behavior: JSON-RPC 2.0 lines on stdin/stdout. `initialize` replies with protocolVersion echoing the client's (2025-06-18 or what agy sends), capabilities `{tools: {}}` and serverInfo foreman. `tools/list` returns the one tool. `tools/call` for `ask_orchestrator` decodes `{question, kind?}` ignoring unknown arguments (agy adds `toolSummary`), mints a callId (uuid), and sends `Ask` through the connect-only daemon client (`call(body, {dataDir, connectOnly: true})` as doctor does; FOREMAN_HOME comes from the env agy passes). The socket request stays open with no timeout. Success replies `{content: [{type: "text", text}]}`; a refusal replies `{content: [{type: "text", text: reason}], isError: true}`; an unreachable daemon replies isError with "The foreman orchestrator is unavailable. Continue without the answer, list the question under Open in your hand-off, and take no irreversible step that depends on it." Other methods: notifications ignored, unknown requests -32601. Exits when stdin closes. Logs nothing to stdout except protocol; diagnostics to the log file only.
- Pure parts (message decode, tool-call decode, reply building) in src/core/mcp-question.ts as functions; the stdin/stdout loop and the daemon call at the edge in src/commands/mcp-question.ts.
- Tests (tests/mcp-question.test.ts): through tests/helpers/cli.ts driving the real command with a real daemon fixture or a fake socket server: initialize, tools/list schema equals Codex's, a call forwarded and answered, toolSummary ignored, refusal becomes isError, daemon unreachable message, unknown method -32601, malformed line is skipped with a log record.

#### Lane b brief (questions in the agy connection and supervisor)

- Goal: agy runs ask through the bridge and the supervisor treats them like Codex questions.
- `src/providers/agy/questions.ts`: pure helpers: the `mcpServers` entry for a session (`{name: "foreman", command: <foreman executable from Host.executable>, args: [...executable rest, "mcp-question", "--run", run], env: [{name: "FOREMAN_HOME", value: home}]}`) and the bookkeeping for held calls (callId to Deferred).
- In src/providers/agy/connection.ts (lane b owns it this phase): `open` passes the bridge on `session/new`; `ask(session, question)`: when the session has no outstanding prompt fail `QuestionRefused{reason: "turn is no longer active"}`; otherwise emit a `QuestionCall` on `questions` stamped with the outstanding turn whose respond/reject/cancel complete a Deferred, and await it. If the awaiting fiber is interrupted (the bridge's socket closed) before an outcome, push an Inbound with `QuestionAbandoned{turn, callId}` (raw null).
- Supervisor (src/supervisor/questions.ts, notifications.ts): `QuestionAbandoned` records the question `cancelled` with resolution reason "the agent's tool call ended before an answer", moves a `waiting` run back to `running`, and later answers to that id take the existing late-answer path. For agy runs, the question timeout is capped at 80 seconds below agy's observed MCP hold (record the cap in run warnings when the requested timeout was higher: "agy holds a question for at most <n>; deferring after <n>"). Measure the hold once against real agy before fixing the number; the probe saw at least 92 s.
- Tests (tests/agy-questions.test.ts): ask with and without an outstanding prompt; respond, reject and cancel outcomes; interruption emits QuestionAbandoned once; the supervisor's abandon transition and late-answer path; the timeout cap and its warning.
- Guide lines for phase 5 lane c go in the plan log: how questions behave on agy and the hold cap.


### Phase 4: steering, budgets and resume on agy

Demo: RFC phase 3 demo.
Depends on: phase 3

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/providers/agy/connection.ts, src/providers/agy/events.ts, src/providers/agy/turns.ts, tests/agy-steer-resume-unit.test.ts | contracts | | opus | pending | | |

Scaffold (written when phase 3 lands): tests/agy-steer-resume.test.ts, real daemon against the fake ACP agent with a `respondAfterSteps` prompt that waits on `awaitRequest: session/prompt`: a steer during a turn sends a second `session/prompt`, the first reply (`end_turn`) does not complete the foreman turn, the second does, usage is summed and a `Steered` event is recorded; a steer after the turn's completion was emitted is refused and the supervisor delivers it as a follow-up; a 45 s budget (use a short budgetMs in the test) interrupts with `session/cancel` and runs a hand-off turn whose edit is refused and whose shell command is approved, ending idle with the hand-off text; after a daemon restart a followup calls `session/resume` with the worktree cwd and the bridge in mcpServers, then `session/set_config_option` with the run's model and effort, records `Resumed{sandbox: "default", model}`, and finishes the turn.

#### Lane a brief

- Goal: steering, budget hand-off and resume for agy, as RFC "Steering", "Interrupt" and "Resume" describe.
- Steering in src/providers/agy/connection.ts: track every outstanding prompt per session. `steer(session, turn, input)` is serialized with prompt-reply handling per session (a Semaphore or a single per-session queue): accepted only while a prompt is outstanding and the turn's TurnCompleted hasn't been emitted, else `SteerRefused{reason: "the agy turn already finished"}`. Accepted steers send `session/prompt` on their own fiber. A reply completes the foreman turn only when no later prompt is outstanding; usage sums across replies. A refusal recorded by any prompt still fails the turn.
- Budget: nothing provider-specific beyond the hand-off permission policy already in permissions.ts and interrupt; verify the supervisor's budget path works end to end on agy and fix only agy code.
- Resume: `resume(run, session, settings)` sends `session/resume {sessionId, cwd, mcpServers}` (the bridge entry from phase 3), then set_config_option model and set_mode default, and returns `{sandbox: "default", model: settings.model}`. `isLoaded` becomes true after resume. Errors as in `open` (auth wording).
- events.ts changes only where steering needs them (stamping updates with the latest outstanding prompt's turn).
- Tests (tests/agy-steer-resume-unit.test.ts, your own): steer accepted and refused windows including the race where the completion is queued; usage sum; resume request sequence; resume auth failure.
- Guide lines for phase 5 lane c go in the plan log.


### Phase 5: the agent experience

Demo: RFC phase 4 demo.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/providers/routing.ts, src/providers/routing-errors.ts, src/core/commands.ts, src/commands/models.ts, src/core/models.ts, src/schemas/models.ts, tests/model-routing.test.ts, tests/provider-routing.test.ts | contracts | | opus | running | deliver/agy-provider-5a | |
| b | M | src/core/doctor.ts, src/core/doctor-providers.ts, src/schemas/doctor.ts, src/commands/doctor.ts, src/providers/agy/launch.ts, tests/doctor-providers.test.ts | contracts | | sonnet | merged | deliver/agy-provider-5b | |
| c | M | src/guide/, scripts/generate-skill.ts, .claude/skills/foreman/, docs/architecture.md, README.md, AGENTS.md, docs/harness.md, .claude/README.md | contracts | | opus | running | deliver/agy-provider-5c | |
| d | S | src/core/monitor/row.ts, src/core/monitor/detail-facts.ts, tests/monitor-provider.test.ts | contracts | | sonnet | running | deliver/agy-provider-5d | |

Scaffold: dc8b733

Phase 5 runs alongside phases 3 and 4 on its own phase branch, `deliver/agy-provider-p5`; its lanes branch from and merge into that branch, which merges into the landing branch when green. Scaffold contents: `ModelUnresolved` in src/errors.ts (exit 2, not retryable, optional `candidates: [{provider, model, efforts}]` carried into the `--json` error envelope), the `models` command registered in src/cli.ts calling a stub in src/core/models.ts, stub `routingError`/`nearMisses` in src/providers/routing-errors.ts, and the phase test tests/agent-experience.test.ts through tests/helpers/cli.ts with fixture catalogs (a Codex models_cache.json and a seeded agy models.json cache): `start --model gemini-4-neo` fails exit 2 with the near-miss text and candidates in `--json`, with no daemon contacted; each RFC routing error row's text; `models --json` lists both providers with efforts and defaults, and an unavailable agy with its reason; `doctor --json` reports codex and agy separately, and "agy: not installed" leaves the exit code 0.

#### Lane a brief (routing errors and `foreman models`)

- Replace phase 2's `Usage` routing errors with `ModelUnresolved` and the RFC "Model routing and its errors" table, every row's text exactly. Near misses: edit distance at most 2 or a catalog id that starts with the input, across both catalogs, with the provider named. The fourth refresh rule: a model in neither catalog with an agy cache older than an hour refreshes agy's catalog once before failing.
- `foreman models [--json]`: provider, model id, valid efforts, default effort, which is the default model; an unavailable provider appears with its reason. Text output is a compact table.
- Tests (tests/model-routing.test.ts): every table row, near-miss ranking, the refresh-once rule, models output in both formats.

#### Lane b brief (doctor)

- `foreman doctor` reports each provider separately as RFC "The agent experience" says: executable and version, sign-in (Codex: today's check; agy: `agy models` succeeds), protocol compatibility (agy: initialize protocol and version against `supportedAgy`), hook trust for the current repo (agy: `agyHookTrust`), catalog size. The exit code reflects only providers that would refuse a start; a missing agy is "agy: not installed" and not a failure. Keep every existing Codex field in `doctor --json` (add an `agy` object rather than renaming).
- Tests (tests/doctor-providers.test.ts): agy present and signed in (fake agent), missing, signed out, the Codex-only hooks refusal shown, exit codes.

#### Lane c brief (guide, skill, contract templates, docs)

- Guide core topic: one provider table (what each is good for, how it signs in, default model and efforts), `foreman models` instead of reading models_cache.json, and the guide lines phases 3 and 4 logged (questions, hold cap, steering, read-only strength on agy: use Codex for an enforced read-only sandbox).
- src/guide/contract.ts templates take the provider: instruction loading (Codex: AGENTS.md and its skills; agy: GEMINI.md, AGENTS.md, .agents/rules/, .agents/skills/) and the self-review command (`codex exec --ephemeral --sandbox read-only ...`; agy: `agy -p --model <model> --output-format text < prompt.md` with a no-edits instruction). Check agy print mode's handling of an edit permission request with one real cheap run (gemini-3.8-flash-low) before finalizing that text, and report what happened.
- Regenerate the skill with `bun scripts/generate-skill.ts`; its description says "Delegate coding work to Codex or Antigravity (Gemini) through foreman".
- README (usage, AGY_BIN, models, agy setup and sign-in), docs/architecture.md (providers, routing, storage fence, agy adapter), the AGENTS.md overview and harness section (.agents/hooks.json), docs/harness.md and .claude/README.md for the agy hook adapter. Keep AGENTS.md under 200 lines.
- Tests: existing guide and skill tests updated for the new text; contract template tests for both providers.

#### Lane d brief (monitor)

- A short provider tag beside the model in list rows and detail facts (`agy` for agy runs; Codex runs show nothing new unless docs/design/monitor.md's column rules make an empty tag ambiguous). Follow docs/design/monitor.md for color and width; nothing else in the TUI changes.
- Tests (tests/monitor-provider.test.ts): rows and facts for both providers at narrow and wide widths.

## Log

- 2026-11-22: RFC 0002 critique ran this session (devil's advocate, 8 findings, all accepted); the plan critique step is skipped per the deliver profile.
- Phase 1 is one L lane by choice: the Codex connection and the supervisor switch can't be tested apart, and two lanes would share registry.ts. It gets a lane review and the phase boundary review.
- Lane 0/b accepted choices: inProgress turn completion maps to completed; completed tool items map to other; the first completed item before any turn/started sets the session's turn (resumed sessions). events.ts is 276 lines, accepted.
- Lane 0/c accepted choices: AGY_BIN passed to a spawned daemon; agyBin/defaultModel decoded independently.
- Contract: ItemStarted.turn nullable so the Codex hook rule fails closed on a partly decoded commandExecution (lane 0/b review, finding beyond the brief).
- Phase 0 gate: five tests used formatVersion 3 as their unknown future version; 3 is now the agy run.json version, so they use 4. tests/supervisor-stress.test.ts failed once under full-suite load (daemon stop saw active runs), passed 4/4 alone on the branch and 3/3 on main, and the gate rerun passed: treated as a load flake.
- Lane 1/a accepted divergences: initialize refusal surfaces as CodexUnavailable; non-blocked hook/completed, non-retry error and non-failed MCP startup no longer adopt a turn for an unknown run; AgentMessage/SubAgent don't clear the open item; unknown-thread questions get -32602 and unsupported tools aren't logged to codex.jsonl; the journal keeps normalized TurnCompleted status (inProgress -> completed) and AgentMessage phase (unknown -> null); an app server lost during thread/name/set becomes a title warning and the run ends unknown at turn/start, keeping its worktree.
- Phase 1 real-Codex smoke: 19 pass, 2 fail, both from the installed Codex 0.171.0 against the 0.169.0 pin (version check, and the resume test's unverified-protocol warning). Resume, write access and hand-off behaved correctly. The pin bump runs as its own branch (deliver/agy-provider-codexpin) before the tag.
- Phase 1 boundary review: 5 findings, all verified against the code and accepted: provider-neutral request failures and steer-fallback by tag, not text; hasRepoHooks/hook-bypass message/default model behind the provider plus a lint rule keeping supervisor off providers/codex; null turn means "unnamed, applies to active" and no-turn messages carry no events; a provider-neutral `ask` for bridge questions; Inbound.raw nullable. Fixed on deliver/agy-provider-1fix.
- Codex pin 0.171.0 merged (c0cab8c): no used method or field changed incompatibly; the full real-Codex smoke suite passed on that branch (21 pass, 0 fail).
- Phase 1 tagged agy-phase-1: a `phase-1` tag from an earlier, unrelated run already exists, so this plan's later tags carry the `agy-` prefix.
- The delegate preamble stays in the first prompt for both providers (src/supervisor/prompts.ts, prepended by turns.ts) instead of agy's `_meta.antigravity.systemPrompt.append`: provider-neutral and already covered by tests. Follow-ups and hand-offs behave as on Codex.
- Phase 2 demo ran against real agy 1.5.14 (gemini-3.8-flash-low): write run with hand-off, Permission events, read-only edit refusal failing the run, followup on the same session, interrupt confirmed in 0.1 s, archive. It found two bugs fixed before the tag: agy's inputTokens excludes cache reads (now input = inputTokens + cachedRead + cachedWrite), and agy titles file permissions relative to its launch directory (now rebuilt relative to the worktree).
- Pre-existing, out of scope: src/core/runs/worktree.ts outsideMayChange parses git status paths without unquoting, so paths with spaces or non-ASCII characters are reported quoted (lane 2/c found it).
- Phase 3 and 5 scaffolds (1d264ff on the landing branch; dc8b733 on deliver/agy-provider-p5) were drafted by a builder and read before landing. Ask's body uses `name`, not `run`. The bridge runs in tests as `bun tests/fixtures/foreman-cli/entry.ts`. Ownership notes: phase 3 lane b updates tests/agy-runs.test.ts's `mcpServers: []` assertion; phase 3 lane a owns src/daemon/client.ts because the connect-only client still stops a daemon whose build differs, which Ask must never do; phase 5 lane a owns tests/provider-routing.test.ts (its Usage assertions become ModelUnresolved) and src/core/commands.ts.
- Phase 5 lane a, "listed by both": detect it by reading agy's cached catalog file when Codex lists the model (no agy process, no refresh, no version check); a missing or stale cache means no ambiguity check, so Codex starts never pay for an agy spawn.
