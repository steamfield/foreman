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

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | src/supervisor/, src/providers/codex/, src/codex/, src/core/runs/normalize.ts, src/core/preflight/hooks.ts, src/core/preflight/model.ts, src/core/doctor.ts, src/core/runs/store.ts, src/commands/monitor.ts, biome-plugins/boundaries.grit, tests/supervisor-integration.test.ts, tests/run-normalize.test.ts, tests/codex-client.test.ts, tests/preflight-hooks.test.ts, tests/preflight-model.test.ts, tests/fixtures/daemon/entry.ts | contracts, docs/architecture.md | tests/cli.test.ts, tests/daemon-lifecycle.test.ts, tests/monitor-feed.test.ts | opus | running | deliver/agy-provider-1a | full gate green |

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
| a | M | src/schemas/acp.ts, src/providers/agy/connection.ts, src/providers/agy/events.ts, src/providers/agy/turns.ts, src/providers/agy/provider.ts, tests/providers/agy-connection.test.ts, tests/acp-schemas.test.ts | contracts, src/providers/codex/connection.ts | tests/agy-runs.test.ts | opus | pending | | agy-connection and acp-schemas tests pass |
| b | S | src/providers/agy/permissions.ts, src/providers/agy/hooks.ts, src/providers/agy/catalog.ts, src/providers/agy/environment.ts, tests/providers/agy-policy.test.ts | contracts | | sonnet | pending | | agy-policy tests pass |
| c | M | src/providers/routing.ts, src/supervisor/connections.ts, src/supervisor/turns.ts, src/supervisor/notifications.ts, src/core/runs/digest.ts, src/core/commands.ts, src/commands/runs.ts, src/daemon/client.ts, tests/provider-routing.test.ts | contracts | tests/agy-runs.test.ts | opus | pending | | provider-routing tests pass; agy-runs passes once lane a lands |
| d | S | .agents/hooks.json, .agents/hooks/, tests/hooks/agy-adapter.test.ts | .claude/hooks/block-destructive.sh, .claude/hooks/detect-secrets.sh | | sonnet | pending | | agy-adapter tests pass |

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
| a | M | src/commands/mcp-question.ts, src/core/mcp-question.ts, tests/mcp-question.test.ts | contracts | | opus | pending | | |
| b | M | src/providers/agy/questions.ts, src/supervisor/questions.ts, src/supervisor/notifications.ts, tests/agy-questions.test.ts | contracts | | opus | pending | | |

### Phase 4: steering, budgets and resume on agy

Demo: RFC phase 3 demo.
Depends on: phase 3

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/providers/agy/connection.ts, src/providers/agy/events.ts, tests/agy-steer-resume.test.ts | contracts | | opus | pending | | |

### Phase 5: the agent experience

Demo: RFC phase 4 demo.
Depends on: phase 2

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/providers/routing.ts, src/commands/models.ts, src/core/models.ts, src/schemas/models.ts, tests/model-routing.test.ts | contracts | | opus | pending | | |
| b | S | src/core/doctor-providers.ts, tests/doctor-providers.test.ts | contracts | | sonnet | pending | | |
| c | M | src/guide/, scripts/generate-skill.ts, docs/architecture.md | contracts | | opus | pending | | |
| d | S | src/core/monitor/row.ts, src/core/monitor/detail-facts.ts, tests/monitor-provider.test.ts | contracts | | sonnet | pending | | |

## Log

- 2026-11-22: RFC 0002 critique ran this session (devil's advocate, 8 findings, all accepted); the plan critique step is skipped per the deliver profile.
- Phase 1 is one L lane by choice: the Codex connection and the supervisor switch can't be tested apart, and two lanes would share registry.ts. It gets a lane review and the phase boundary review.
- Lane 0/b accepted choices: inProgress turn completion maps to completed; completed tool items map to other; the first completed item before any turn/started sets the session's turn (resumed sessions). events.ts is 276 lines, accepted.
- Lane 0/c accepted choices: AGY_BIN passed to a spawned daemon; agyBin/defaultModel decoded independently.
- Contract: ItemStarted.turn nullable so the Codex hook rule fails closed on a partly decoded commandExecution (lane 0/b review, finding beyond the brief).
- Phase 0 gate: five tests used formatVersion 3 as their unknown future version; 3 is now the agy run.json version, so they use 4. tests/supervisor-stress.test.ts failed once under full-suite load (daemon stop saw active runs), passed 4/4 alone on the branch and 3/3 on main, and the gate rerun passed: treated as a load flake.
