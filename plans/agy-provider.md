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

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | L | src/supervisor/, src/providers/codex/, src/codex/, src/core/runs/normalize.ts, src/core/preflight/hooks.ts, src/core/preflight/model.ts, src/core/doctor.ts, src/core/runs/store.ts, src/commands/monitor.ts, biome-plugins/boundaries.grit, tests/supervisor-integration.test.ts, tests/run-normalize.test.ts, tests/codex-client.test.ts, tests/preflight-hooks.test.ts, tests/preflight-model.test.ts, tests/fixtures/daemon/entry.ts | contracts, docs/architecture.md | tests/cli.test.ts, tests/daemon-lifecycle.test.ts, tests/monitor-feed.test.ts | opus | pending | | full gate green |

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

Demo: RFC phase 1 demo.
Depends on: phase 1

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | src/schemas/acp.ts, src/providers/agy/connection.ts, src/providers/agy/events.ts, src/providers/agy/provider.ts, tests/fixtures/fake-acp-agent/, tests/providers/agy-connection.test.ts | contracts | | opus | pending | | |
| b | S | src/providers/agy/permissions.ts, src/providers/agy/hooks.ts, src/providers/agy/catalog.ts, src/providers/agy/environment.ts, tests/providers/agy-policy.test.ts | contracts | | sonnet | pending | | |
| c | M | src/providers/registry.ts, src/supervisor/connections.ts, src/supervisor/turns.ts, src/core/commands.ts, src/daemon/client.ts, tests/agy-supervisor.test.ts | contracts | | opus | pending | | |
| d | S | .agents/hooks.json, .agents/hooks/, tests/hooks/agy-adapter.test.ts | | | sonnet | pending | | |

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
