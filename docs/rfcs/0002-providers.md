# RFC 0002: providers, and Antigravity as the second one

Status: revised after devil's-advocate review; ready for conversion to a deliver plan. Date: 2026-11-22. Built against foreman 0.3.1, Codex CLI 0.169.0 and Antigravity CLI (`agy`) 1.5.14.

## Summary

foreman delegates to one agent today: Codex, driven through `codex app-server`. This RFC makes the agent a provider behind one contract, then adds Antigravity's `agy` as the second provider so Claude can hand work to Gemini 4 Neon (and the other models agy serves) with the same commands, the same supervision and the same hand-off it already uses for Codex.

Claude picks a provider by naming a model. `foreman start api-tests --model gemini-4-neon --new-worktree --write --contract c.md --wait` runs on agy; `--model gpt-6.1-sol` runs on Codex; no `--model` keeps today's Codex default. Every later command (`wait`, `status`, `answer`, `steer`, `followup`, `interrupt`, `result`, `archive`, `monitor`) takes a run name and works the same whatever the provider, because the provider is recorded on the run.

agy exposes the Agent Client Protocol (ACP) over stdio with `agy acp`, which is newline-delimited JSON-RPC 2.0 like the Codex app server. One `agy acp` child serves many sessions, as one app server serves many threads. The daemon, run store, worktrees, questions, deferral, budgets, hand-offs, digests, wait cursors and the monitor are shared; only the wire protocol, the event decoding and a few capabilities differ per provider.

The work lands in five phases. Phase 0 is a behavior-preserving refactor that puts Codex behind the provider contract with no user-visible change. Phase 1 runs an agy turn end to end, with permissions, interrupt and the repo-hook guard. Phase 2 adds agy questions. Phase 3 adds steering, budgets and resume. Phase 4 brings the agent experience to parity: model routing errors, `foreman models`, doctor, guide, skill, contract templates and monitor.

## Decisions already made

| Topic | Decision |
| --- | --- |
| Provider selection | Inferred from `--model`. foreman resolves the model against each provider's live catalog; there is no `--provider` flag. A `provider:model` form exists only to disambiguate (see Model routing) |
| agy authentication | agy's own sign-in. foreman strips `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_GENAI_*` key variables from the child environment, as it strips `OPENAI_API_KEY` for Codex, so runs never bill to an API key by accident |
| agy permissions | foreman is the ACP client and answers agy's `session/request_permission` itself: write runs approve, read-only runs reject agy's edit tools (see Permissions for why shell stays allowed), and every decision is an event. foreman never passes `--dangerously-skip-permissions` |
| Shape | One `foreman` CLI, one daemon, one run store, one skill. No provider namespaces in the command tree |
| Delivery | Through `ce:deliver` after this RFC is reviewed: phases land on `deliver/agy-provider`, and the merge to `main` waits for approval |

## What the probes established

agy 1.5.14 on this machine, signed in with a personal Google account, answered an ACP handshake from a throwaway repo:

| Question | Result |
| --- | --- |
| Transport | `agy acp` (stdio default) speaks JSON-RPC 2.0, one JSON object per line, the same framing foreman's Codex client already reads |
| `initialize` | `protocolVersion: 1`; `agentCapabilities.loadSession: true`; `sessionCapabilities` has `resume`, `close`, `load`, `list`, `additionalDirectories`; `promptCapabilities` has `image` and `embeddedContext`; `_meta.antigravity.systemPrompt.append: true`; `agentInfo.version: "1.5.14"`. Four auth methods are advertised: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` |
| `session/new {cwd, mcpServers}` | Returns `sessionId`, the model catalog (`models.availableModels`, `currentModelId: "gemini-4-neon-high"`), the modes `default`, `accept-edits`, `auto` and `plan`, and `configOptions` for `model` (family ids such as `gemini-4-neon`) and `thought_level`. Then `session/update` notifications `available_commands_update` and `usage_update` (`size: 1048576`) |
| Model catalog | Gemini 4 Neon, Argon and Hydrogen at several thinking levels, Gemini 3.8 Flash, two Gemini orchestrator models, Claude Opus 5.5, Claude Sonnet 5.5 and GPT-OSS 120B. The catalog depends on the sign-in: the changelog adds Neon per auth method across 1.5.12 and 1.5.13 |
| `session/list` | Lists the user's other agy conversations, so foreman must route by the session ids it created and never by listing |

A second probe ran 16 small prompts (15 on `gemini-3.8-flash-low`, one on `gemini-4-neon-low`) against throwaway repos. Raw logs and scripts were kept in the session scratchpad; the recorded shapes become test fixtures in phase 1.

| Question | Result |
| --- | --- |
| Setting model and effort | `session/set_config_option {sessionId, configId: "model", value: "gemini-4-neon-low"}` accepts a full catalog id and sets both `model` and `thought_level` in one call, replying with the full `configOptions`. `thought_level` options vary by model (Flash has no `xhigh`). `session/set_mode {modeId}` sets the mode. Each change emits `config_option_update` |
| `session/prompt` | Request `{sessionId, prompt: [{type: "text", text}]}`. Reply `{stopReason, usage: {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens}}`. Seen stop reasons: `end_turn`, `cancelled` |
| Updates during a turn | `tool_call`, `tool_call_update`, `agent_message_chunk`, `agent_thought_chunk` (Neon only), `usage_update`, `session_info_update` (an auto title), `config_option_update`, `current_mode_update`, `available_commands_update`. No `plan` update appeared, even in plan mode |
| Tool calls | Standard ACP fields plus `name` and `args`. Reads are `kind: "read"`. Edits are `write_file` or `edit_file` with `kind: "edit"`, completing with `content: [{type: "diff", path, oldText?, newText}]`. Shell is `run_command`, `kind: "execute"`, args `{CommandLine, ...}`, completing with `rawOutput: {output, exit_code}`. MCP tools are `mcp_<server>_<tool>` with `kind: "other"`. Status runs `in_progress`, `pending` while a permission request is open, then `completed` or `failed` |
| When agy asks permission | Reads never ask in any mode. `default` asks for every edit, every shell command (even `pwd`) and every MCP tool call. `accept-edits` asks for shell only. `auto` asks for nothing. `plan` skipped workspace edits but wrote a plan file into agy's own data directory without asking, and still asked to run shell commands |
| Permission request | `session/request_permission` with a string JSON-RPC id, `params: {sessionId, toolCall, options: [{optionId: "allow", kind: "allow_once"}, {optionId: "deny", kind: "reject_once"}]}`. No `allow_always` was offered |
| Rejecting a permission | The tool and any queued parallel tool become `failed`, and the turn ends at once with `end_turn` and no further message. There is no refuse-and-continue |
| `--sandbox` | With `--dangerously-skip-permissions` it restricted nothing: `curl` reached the network and a write outside the repo succeeded. The changelog ties the sandbox to `auto` mode; untested otherwise. In `auto` mode `git status` failed with an fsmonitor IPC error |
| Client capabilities | agy did all file IO and shell itself and sent no `fs/*` or `terminal/*` requests, even when the client advertised fs support |
| MCP servers on `session/new` | A stdio entry `{name, command, args, env: []}` works. agy speaks MCP `2025-11-25` to it, calls `tools/list`, and adds `_meta` with `conversation_id` to `tools/call`; the model also added an undeclared `toolSummary` argument. A call held for 20 s returned normally; one held for 92 s was still waiting when cancelled, so any tool timeout is above 92 s. The user's global MCP servers did not start alongside |
| `session/cancel` | During a held MCP call, the prompt replied `cancelled` within milliseconds after a `failed` tool update. The MCP server received no `notifications/cancelled` |
| Second prompt during a turn | Merged into the running turn. The first prompt replied `end_turn` immediately with partial usage; the turn continued under the second prompt, whose reply came 20 s later, and the final answer followed the second prompt's instruction |
| Restart, then `session/load` | Replays history as `user_message_chunk`, completed `tool_call`s and one consolidated `agent_message_chunk` before replying; context is kept. The model reverts to the default (Neon High) and must be set again |
| Restart, then `session/resume` | Same reply shape, no replay, context kept (tested on Neon) |
| `_meta.antigravity.systemPrompt.append` on `session/new` | Honored, and it persists across restart and load without being passed again |
| Repo hooks | agy reads `hooks.json` from `.agents/` (also `.agent/`, `_agents/`, `_agent/`) walking from cwd to the repo root, plus global and plugin hooks. A project `.agents/hooks.json` in an untrusted repo ran over ACP with no trust step (`SessionStart` at the first prompt, `PreInvocation`, `PreToolUse`, `Stop`). A PreToolUse `deny` failed the tool without a permission request, and unlike a refused permission the turn continued. ACP has no hook listing method and sends no hook notifications. PreToolUse input names the tool as `run_command`, `edit_file` and so on, with agy's own argument names |
| Launch directory | Hook input `workspacePaths` included the directory `agy acp` was launched from as well as the session cwd |
| Auth | This machine authenticates through the OS keyring, which won even with a bogus `GEMINI_API_KEY` set. A logged-out state was not observed; strings suggest an `auth_required` error on session requests |
| Usage | `usage_update {used, size}` is context-window occupancy. The token bill is the prompt reply's `usage`; under a merged steer it is split across the merged prompts |
| Concurrency | One process without `--process-per-session` ran two sessions in different cwds at once, each with its own `pwd`, model and system prompt |
| Persistence | Every session is kept in agy's own history under `~/.gemini/antigravity-cli/` and listed by `session/list`, as Codex threads appear in the Codex app |

## Goals and non-goals

Goals: Claude uses agy with the commands, outputs, exit codes, wait semantics, question flow and hand-off it already knows from Codex. Shared infrastructure stays shared: a fix to budgets, worktrees, the store or wait applies to both providers. A third ACP agent (Gemini CLI, Claude Code through an ACP adapter, others) would need a model catalog entry and capability flags, not a new supervisor.

Non-goals: cross-provider runs (a follow-up on a different provider than the run started on), automatic provider fallback when one is unavailable, an agy remote-agent mode, agy swarms, and the MCP server wrapper that RFC 0001 deferred.

## Design

### The provider contract

Today the supervisor reads Codex messages directly: `notifications.ts` decodes `turn/*`, `item/*` and `hook/*`, `turns.ts` calls `thread/start` and `turn/start`, `questions.ts` answers `item/tool/call`, and `registry.ts` stores Codex `ThreadItem`s. Twenty source files mention Codex; seven import its client or schemas.

Phase 0 puts a seam between "drive this agent" and "supervise a run". The supervisor keeps every state machine it has. Each provider turns its wire protocol into a small set of provider events and accepts a small set of commands:

```ts
// src/providers/contract.ts: the only provider types the supervisor imports.
export type ProviderId = "codex" | "agy";

export interface Capabilities {
  readonly serviceTier: boolean;         // --tier is Codex-only
  readonly hookEvents: boolean;          // the wire reports project hook runs (Codex yes, agy no)
  readonly subagents: boolean;           // Codex reports subAgentActivity items
  readonly efforts: readonly string[];   // valid --effort values
}

export type SessionSettings = {
  readonly cwd: string;
  readonly model: string;
  readonly effort: string;
  readonly tier: string | null;
  readonly access: "read-only" | "write";
};

// What a provider reports. Each event carries the provider's session id and the turn it
// belongs to; the supervisor routes by session id exactly as it routes by thread id today.
export type ProviderEvent =
  | { _tag: "TurnStarted"; session: SessionId; turn: TurnId }
  | { _tag: "TurnCompleted"; session: SessionId; turn: TurnId;
      status: "completed" | "interrupted" | "failed"; failure: RunFailure | null;
      handoff: string | null }
  // kind and id come from a minimal decode; summary is null when the full shape didn't decode,
  // so the hook rule and unknown-state recovery still see a command start (notifications.ts:98-126)
  | { _tag: "ItemStarted"; session: SessionId; turn: TurnId; kind: string; id: string;
      summary: ItemSummary | null }
  | { _tag: "ItemCompleted"; session: SessionId; turn: TurnId; item: ItemSummary }
  // phase "commentary" feeds lastCommentary; "final_answer" is the hand-off text. Persisted
  // as today's AgentMessage event, which monitor review.ts and preview.ts read.
  | { _tag: "AgentMessage"; session: SessionId; turn: TurnId; text: string;
      phase: "commentary" | "final_answer" | null }
  | { _tag: "SubAgent"; session: SessionId; turn: TurnId; activity: SubAgentActivity }
  | { _tag: "HookStarted"; session: SessionId; turn: TurnId | null; project: boolean }
  | { _tag: "HookBlocked"; session: SessionId; turn: TurnId | null; event: string; feedback: string }
  | { _tag: "TokenUsage"; session: SessionId; turn: TurnId; totals: TokenTotals }
  | { _tag: "Retrying"; session: SessionId; turn: TurnId; message: string }
  | { _tag: "McpStartupFailed"; session: SessionId | null; server: string; error: string | null }
  | { _tag: "Permission"; session: SessionId; turn: TurnId; kind: string; title: string;
      decision: "approved" | "rejected" }
  | { _tag: "Activity"; session: SessionId }   // deltas: refresh the quiet clock only
  // A message the adapter recognized but decoded only partly or not at all: becomes today's
  // per-run warning ("... used a partial reply" / "could not be decoded").
  | { _tag: "DecodeIssue"; session: SessionId; method: string; issue: "minimal" | "invalid" }
  // A routed message the adapter doesn't map: becomes today's Other {method} event.
  | { _tag: "Unrecognized"; session: SessionId; method: string }
  // agy only: the bridge's socket closed before an answer (agy timed out or killed the MCP
  // child). The supervisor cancels the question and returns the run to running.
  | { _tag: "QuestionAbandoned"; session: SessionId; call: QuestionCallId };

// ItemSummary is what normalize.ts and the monitor already use from Codex items:
// kind command | fileChange | agentMessage | tool | other, plus command text, exit code,
// output tail and changed paths when the kind has them.

export interface QuestionCall {
  readonly session: SessionId;
  readonly turn: TurnId;
  readonly question: string;
  readonly kind: QuestionKind;
  readonly respond: (text: string) => Effect.Effect<void, ProviderUnavailable>;
  readonly reject: (reason: string) => Effect.Effect<void, ProviderUnavailable>;
}

export interface ProviderConnection {          // one agent child process, today's AppServer
  readonly generation: symbol;
  readonly events: Stream.Stream<ProviderEvent, ProviderUnavailable>;
  readonly questions: Stream.Stream<QuestionCall, ProviderUnavailable>;
  readonly raw: Stream.Stream<RawMessage>;     // for runs/<name>/<provider>.jsonl
  readonly open: (run: RunName, settings: SessionSettings, title: string)
    => Effect.Effect<SessionId, ProviderUnavailable | ProviderRefused>;
  readonly resume: (session: SessionId, settings: SessionSettings)
    => Effect.Effect<ResumeReport, ProviderUnavailable | ProviderRefused>;
  readonly loaded: (session: SessionId) => boolean;
  // turn is the run's persisted turn number; agy derives its turn id from it so ids stay
  // stable across daemon restarts.
  readonly startTurn: (session: SessionId, turn: number, input: string, settings: SessionSettings)
    => Effect.Effect<TurnId, ProviderUnavailable | ProviderRefused>;
  readonly steer: (session: SessionId, turn: TurnId, input: string)
    => Effect.Effect<void, ProviderUnavailable | ProviderRefused | SteerRefused>;
  readonly interrupt: (session: SessionId, turn: TurnId)
    => Effect.Effect<void, ProviderUnavailable | ProviderRefused>;
  readonly hookTrust: (mainCheckout: string, worktree: string)
    => Effect.Effect<HookTrust, ProviderUnavailable>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
  readonly catalog: Effect.Effect<ModelCatalog, CatalogUnavailable>;  // see Model routing
  readonly connect: Effect.Effect<ProviderConnection, ProviderUnavailable, Scope.Scope>;
  readonly environment: Effect.Effect<Record<string, string>>;
  // Codex reads hooks from the main checkout; agy from the worktree it runs in.
  readonly hasRepoHooks: (mainCheckout: string, worktree: string)
    => Effect.Effect<boolean, PermissionDenied | RepoHooksUntrusted>;
  readonly doctor: (cwd: string) => Effect.Effect<ProviderDoctorReport>;
}
```

Notes on the shape:

`startTurn` returns once the provider has accepted the turn, and the turn's end always arrives as a `TurnCompleted` event. Codex already works that way (`turn/start` replies, `turn/completed` follows). In ACP the `session/prompt` request stays open for the whole turn and its reply is the completion, so the agy adapter sends it on a fiber owned by the connection, returns a turn id it mints, and converts the reply into `TurnCompleted`. The supervisor never learns that difference.

`handoff` is chosen by the adapter. Codex keeps `pickHandoff` (the `final_answer` message, else the last agent message). agy takes the agent message text streamed after the turn's last tool call, else all message text of the turn, and emits it as an `AgentMessage` with phase `final_answer` just before `TurnCompleted`, so the monitor's review and preview projections find it as they do for Codex.

Turn ids. The supervisor's stale-turn filter (`notifications.ts:169-183`) drops events whose turn isn't the active one, and it stays. Codex events carry real turn ids. The agy adapter stamps an update with the turn of the prompt that is outstanding when it arrives, and stamps nothing (logging it raw only) when no prompt is outstanding, so updates that trail a cancelled prompt never land in the hand-off turn that follows.

Every call the supervisor makes for a run goes to that run's provider connection. Today `answer`, `defer`, `interrupt` and `steer` reach the app server through `servers.get` (`src/supervisor/index.ts:265`, `:478`, `:488`); they become `connections.forRun(run)`, so answering an agy question never starts a Codex child.

`registry.cancelQuestions` (`registry.ts:361`) only writes history today, because Codex drops a held tool call itself when its turn ends. It now also calls `reject` on each held `QuestionCall`, which is a no-op for Codex and releases the bridge's socket request for agy.

The hook check moves behind `hookTrust` and `hasRepoHooks` because the trust source differs per provider: Codex's `hooks/list`, and for agy a decode of `.agents/hooks.json` (see Repo hooks). The supervisor keeps the enforcement rule itself: when a provider reports hook events and says the repo has hooks, a command item before any project `HookStarted` interrupts the turn.

Steering needs no capability flag: both providers steer a live turn, Codex through `turn/steer` and agy by merging a second prompt (see Steering).

`ProviderConnections` (renamed from `AppServers` in `src/supervisor/app-server.ts`) keeps one lazily started connection per provider, with today's generation, retirement, stderr redaction and loss handling unchanged. A run records the generation of its provider's connection; losing the agy child marks only agy runs lost.

### What moves where

```
src/
  providers/
    contract.ts          Provider, ProviderConnection, ProviderEvent, Capabilities; types only
    registry.ts          the provider table and model routing (resolveModel); no I/O of its own
    jsonrpc.ts           NDJSON JSON-RPC 2.0 over a child's stdio; extracted from codex/client.ts
    environment.ts       shared env filtering, delegate markers and SSH probe use
    codex/
      provider.ts        Provider for Codex: wires the pieces below
      connection.ts      thread/turn requests over jsonrpc.ts (today's codex/client.ts calls)
      events.ts          Codex notifications -> ProviderEvent (today's notifications.ts decode + normalize.ts)
      questions.ts       item/tool/call <-> QuestionCall
      hooks.ts           hooks/list trust (today's core/preflight/hooks.ts Codex half)
      catalog.ts         models_cache.json reader (today's core/preflight/model.ts)
      check.ts, protocol.ts   unchanged, moved
    agy/
      provider.ts        Provider for agy
      connection.ts      ACP initialize, session/new|load, session/prompt fiber, cancel
      events.ts          session/update -> ProviderEvent, handoff text, synthetic turn ids
      permissions.ts     session/request_permission policy (pure: request + access -> decision)
      questions.ts       the ask_orchestrator MCP bridge (see Questions on agy)
      hooks.ts           finds and decodes .agents/hooks.json; flags Codex-only guarding
      catalog.ts         model catalog from `agy models`, cached under FOREMAN_HOME
  schemas/
    codex.ts             unchanged (wire shapes)
    acp.ts               new: the ACP messages foreman sends and reads, fields it uses only
  supervisor/
    notifications.ts     consumes ProviderEvent only; no wire decoding
    turns.ts, questions.ts   call ProviderConnection; no method names
```

`src/codex/` disappears into `src/providers/codex/`. Imports of `../schemas/codex` from the supervisor, registry and core end; `tests/schema-conventions.test.ts` and a new Grit rule in `biome-plugins/boundaries.grit` keep `schemas/codex.ts` and `schemas/acp.ts` importable only from their provider directory.

The registry's `Run.items: ThreadItem[]` becomes `ItemSummary[]`, `Run.calls` holds `QuestionCall`s instead of RPC ids, and `Run.serverGeneration` stays a symbol. Monitor projections already speak in commands, files, commentary and subagents, so the TUI needs no change beyond showing the provider.

### The agy adapter

Process. The daemon starts one `agy acp --disable-telemetry --log-file <home>/logs/agy-acp.log` child on first need, with the filtered environment and its process cwd set to an empty directory under the foreman home (`<home>/providers/agy/cwd`), because agy adds its launch directory to every session's workspace paths. `initialize` advertises no fs or terminal capabilities; agy does its own file IO and shell either way. One child serves every agy run, as one app server serves every Codex run; the probe ran concurrent sessions in different worktrees on one process without interference. `--process-per-session` stays available as a fallback if isolation problems show up, and is not used by default.

Sessions. `open` calls `session/new` with:

- `cwd`: the worktree.
- `mcpServers`: the question bridge for this run (see Questions on agy).
- `_meta.antigravity.systemPrompt.append`: the delegate preamble, adapted for agy. It persists with the session across restarts, so follow-ups and the budget hand-off don't resend it, and the contract becomes the first prompt alone.

It then calls `session/set_config_option {configId: "model", value: "<family>-<effort>"}`, which sets model and thinking level in one call, and `session/set_mode {modeId: "default"}`. Every run uses `default` mode, write and read-only alike, so every edit, shell command and MCP call reaches foreman's permission policy. The access level lives in foreman's policy, not in agy's mode. `auto` is not used: it hides commands from foreman, and its sandbox broke `git status` in the probe. `plan` is not used either, because it writes into agy's own data directory and still runs approved shell commands. The agy session id is stored in the run record's `threadId` field (see Storage).

Turns. `startTurn` mints `TurnId` `t<turns>`, sends `session/prompt {sessionId, prompt: [{type: "text", text}]}` with no request timeout on a connection-owned fiber, and emits `TurnStarted`. The turn ends when the latest outstanding prompt for that session replies (see Steering). `stopReason` maps to `TurnCompleted.status` as follows:

- `end_turn` is completed.
- `cancelled` is interrupted.
- `max_tokens`, `max_turn_requests` and `refusal` are failed, with a failure message naming the stop reason.
- A JSON-RPC error is failed with its message. An `auth_required`-style error maps to `ProviderUnavailable` with "sign in to agy by running `agy`, then run foreman doctor".

A dropped child fails every open prompt fiber, and the existing loss path marks those runs lost.

Events. `session/update` kinds map as follows. The tool call's `kind` decides the item kind, and `name` breaks ties.

| ACP update | ProviderEvent |
| --- | --- |
| `tool_call` with `kind: "execute"` | `ItemStarted` command, command text from `args.CommandLine`, else `title` |
| `tool_call_update` to `completed` or `failed` on an execute call | `ItemCompleted` command, with `rawOutput.exit_code` and the tail of `rawOutput.output` |
| `tool_call_update` to `completed` with `kind: "edit"`, `"delete"` or `"move"` | `ItemCompleted` fileChange, with paths from `content[].path` (diffs) and `locations[].path` |
| `tool_call` named `mcp_foreman_ask_orchestrator` | Nothing; the bridge reports the question through the daemon |
| Other `tool_call` kinds (`read`, `search`, `fetch`, `think`, `other`) | `ItemStarted` and `ItemCompleted` tool (activity, not a command) |
| `agent_message_chunk` | Appended to the turn's message buffer. When the next tool call starts, the buffer since the previous tool call becomes `Commentary` |
| Prompt reply `usage` | `TokenUsage`, summed into run totals (`inputTokens`, `cachedReadTokens` as cached input, `outputTokens`, `thoughtTokens` as reasoning output), and summed across merged prompts |
| `agent_thought_chunk`, `usage_update`, `session_info_update`, `config_option_update`, `current_mode_update`, `available_commands_update` | `Activity`. `usage_update` is context occupancy, not a bill |

The hand-off is the agent message text after the turn's last tool call, else all message text of the turn.

Permissions. `session/request_permission` is answered by `permissions.ts`, a pure function of the tool call (`kind` and `name`), the run's access and the turn kind. It always picks the request's `allow_once` or `reject_once` option by kind, never by option id:

| Request | Write run | Read-only run | Hand-off turn |
| --- | --- | --- | --- |
| `mcp_foreman_ask_orchestrator` | allow | allow | reject |
| `execute` (shell) | allow | allow, see below | allow |
| `edit`, `delete`, `move` | allow | reject | reject |
| any other kind | allow | allow | allow |
| a session foreman did not create | reject | reject | reject |

Each decision emits a `Permission` event, so `foreman events` and the monitor show what ran and what was refused.

Hand-off turns allow shell for the same reason: a model asked to stop and report usually runs `git status` or `git diff` first, and a refusal there would end the hand-off with no text. They refuse edits and a further question, as Codex's read-only hand-off sandbox does.

A refusal ends agy's turn on the spot, unlike a Codex sandbox denial, which lets the model carry on. When the turn that follows a refusal completes, foreman records it as failed with `foreman refused <title> (<kind>) in a read-only run; agy ends a turn when a permission is refused. Follow up with narrower instructions or start a write run.` The digest shows that failure, and `wait` reports the run as failed rather than done.

Read-only is weaker on agy than on Codex, and the RFC chooses the useful version of it. Codex enforces read-only with an OS sandbox that still lets commands run. On agy, refusing shell would end the turn at the first `git status` or test command, which would make read-only agy runs useless for review and investigation. So read-only agy runs approve shell commands and refuse only agy's own edit tools. A shell command can still write files. foreman makes that visible instead of preventing it:

- The run gets the warning "read-only on agy blocks agy's edit tools but not shell commands".
- When the turn ends, paths in `newInGitStatus` (Git status against `baseline.txt`, which leaves out ignored build output and caches) add the warning "read-only agy run changed files: <paths>", and the run is marked failed. `filesWritten` is not used for this, because its modification-time scan also sees test caches and build artifacts.
- The guide tells Claude to use Codex when it needs an enforced read-only sandbox.

Questions on agy. ACP has no dynamic tools, but `session/new` takes MCP servers, so foreman passes one stdio server per session: `{name: "foreman", command: <current executable>, args: ["mcp-question", "--run", <name>], env: [{name: "FOREMAN_HOME", value: <home>}]}`. The bridge belongs to the agy adapter, and questions still reach the supervisor as `QuestionCall`s on the agy connection's `questions` stream:

- The hidden `foreman mcp-question` command is an MCP server exposing `ask_orchestrator` with the schema Codex gets today. It ignores undeclared arguments, such as the `toolSummary` agy adds.
- On a call, it opens the daemon socket with the connect-only client that doctor uses. It never spawns or replaces a daemon from inside agy. It then sends a new `Ask` request carrying the run name, question and kind.
- The daemon hands `Ask` to the agy connection. If no prompt is outstanding for that run's session, the connection answers with a refusal at once, and the bridge returns the MCP tool error "turn is no longer active", matching Codex's turn check (`questions.ts:128-132`). Otherwise it emits a `QuestionCall` stamped with the outstanding turn and the connection's generation. `respond` and `reject` answer the held socket request, so the generation check (`questions.ts:76-84`) applies unchanged. A daemon restart drops the socket and the call with the old generation.
- If the held socket closes before an answer (agy timed out the MCP call, killed the MCP child, or the turn was cancelled), the connection emits `QuestionAbandoned`. The supervisor records the question `cancelled` and moves a `waiting` run back to `running`. A later `answer` to that id takes the existing late-answer path (steer, or a follow-up), never `delivery: response` to a dead socket.
- When the daemon cancels a question (interrupt, turn end, budget), `cancelQuestions` calls `reject`, and the bridge returns an MCP tool error. agy itself never tells the MCP server about a cancellation.
- If the daemon can't be reached, the bridge returns a tool error telling the model the orchestrator is unavailable: continue without the answer, list the question under Open, and take no irreversible step on it.

Answer, defer, late answers, corrections and the deferral timeout stay in `supervisor/questions.ts`. `session/resume` passes `mcpServers` again, so the tool survives a daemon restart, which Codex's resumed threads don't guarantee. The probe saw a hold of at least 92 seconds, not 15 minutes. Phase 2's smoke case holds a question for 16 minutes. If agy cuts it off sooner, the abandon path keeps the run consistent, agy runs cap their question timeout below the observed limit, and the guide states the cap.

Steering. agy merges a `session/prompt` sent during a running turn into that turn: the earlier prompt replies `end_turn` at once, and the later prompt's reply ends the real turn. `steer` sends a second prompt on its own fiber, and the adapter tracks every prompt it has outstanding per session:

- A reply only completes the foreman turn when no later prompt is outstanding.
- Usage from every reply is summed.
- `steer` and prompt replies are serialized in the adapter, per session. A steer is accepted only while a prompt is outstanding and the turn's completion hasn't been emitted. After that point it returns `SteerRefused`, as Codex refuses a steer whose `expectedTurnId` is no longer active, and the supervisor's existing fallback (wait for inactivity, then follow up) delivers the message. This closes the case where a completion is already queued for the supervisor while a second prompt starts agy working on, unsupervised.
- A steer accepted just before agy finishes by itself becomes a new agy turn that agy runs straight after. The first reply arrives while the steer's prompt is still outstanding, so the foreman turn stays open until the second reply. Budget and supervision cover it, and the steer message is acted on.

The supervisor's steer path, the `Steered` event and late-answer delivery by steer apply unchanged.

Interrupt. `interrupt` sends the `session/cancel` notification and resolves when the outstanding prompts reply `cancelled`. The bound is 30 seconds; after that, the run enters `unknown` and the existing five-minute recovery applies, as for an unconfirmed Codex interrupt.

Resume. `resume` calls `session/resume` with the same `cwd` and `mcpServers`, then sets the model and thinking level again, because agy reverts a restored session to its default model. `session/load` replays history as live updates, so it isn't used. The `Resumed` event records the model foreman set.

Repo hooks. agy runs a repo's `.agents/hooks.json` without asking for trust, so Codex's failure mode, where an unapproved hook silently doesn't run, doesn't exist on agy. The trust check is therefore narrower:

- `hasRepoHooks` looks for `hooks.json` under `.agents/`, `.agent/`, `_agents/` or `_agent/` in the worktree, since that's the copy agy loads. Codex resolves its hooks from the main checkout, so the Codex adapter keeps checking there. An uncommitted `.agents/hooks.json` in the main checkout that isn't in a new worktree counts as missing.
- `hookTrust` decodes the file against agy's documented hook schema and refuses start with `RepoHooksUntrusted` when the file is unreadable or doesn't match, since agy would skip a hook it can't load.

ACP doesn't report hook runs, so the supervisor's "a command before any project hook" rule can't run for agy. `Capabilities` gains `hookEvents: boolean`, and the rule applies only when it's true. A command a hook denies arrives as a `failed` execute call with no permission request. foreman can't tell that apart from a failing tool, so it isn't counted in `blockedByHooks`.

A repo guarded for Codex alone is the gap that matters: `.codex/hooks.json` with no `.agents/hooks.json`, which is this repo today. An agy run there would run unguarded. foreman refuses start with `RepoHooksUntrusted` and this message: `<main> has Codex hooks (.codex/hooks.json) but no agy hooks (.agents/hooks.json) in <worktree>; agy runs would skip the repo's guards. Add and commit .agents/hooks.json, then run foreman doctor.` This refusal ships in phase 1, with the first agy write run, and phase 1 adds `.agents/hooks.json` to this repo, with an adapter that turns agy's PreToolUse input (`toolCall.name` `run_command`, `args.CommandLine`) into the input `block-destructive.sh` reads.

Environment. Shared filtering drops `CLAUDE_*`, `FOREMAN_*` and `LOG_LEVEL` for every provider and adds `STACKS_DELEGATE=1`. Codex keeps its own extra drops and `CODEX_DELEGATE=1`. agy also drops these, and adds `AGY_DELEGATE=1`:

- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`
- `GOOGLE_GENAI_USE_ENTERPRISE`, `AGY_ADC_AUTH`, `ANTIGRAVITY_PROJECT_ID`

With them gone, agy uses its keyring sign-in. `config.inDelegate` is true under any of the delegate markers, so `foreman monitor` inside a delegated agy shell prints a snapshot rather than an alternate screen. foreman never passes `--app-data-dir`, which agy only accepts as a path relative to `~/.gemini`.

Compatibility check. agy has no schema export. The adapter checks the `initialize` reply's `protocolVersion` and `agentInfo.version` against `supportedAgy = {protocolVersion: 1, version: "1.5.14"}`:

- A different protocol version refuses start.
- A different agy version adds a run warning, as a Codex schema-hash mismatch does.
- Reply shapes that stop decoding fail the request, as they do for Codex.

### Model routing and its errors

The model names the provider. Routing reads catalogs, not name patterns, so a new Gemini or GPT model works the day the provider lists it, and a model that agy serves under a familiar name (`claude-opus-5-5`, `gpt-oss-120b-medium`) routes to agy because only agy lists it.

Catalogs. Codex's is `CODEX_HOME/models_cache.json`, entries with `visibility: "list"`, which foreman already reads for the default model. agy's comes from `agy models`, which prints one `<id>\t<name>` line per model (for example `gemini-4-neon-high\tGemini 4 Neon (High)`). It took 1.4 seconds and left no conversation in agy's history in the probe, unlike `session/new`. foreman groups the ids into families and efforts by their `-low|-medium|-high|-xhigh` suffix, and keeps an id with no suffix (`gpt-oss-120b-medium` has a fixed effort) as its own family. The result is cached at `FOREMAN_HOME/providers/agy/models.json` with its fetch time and the agy version, written to a temporary file and renamed, so concurrent starts never read a torn cache.

Refreshes happen in these cases:

- the cache is missing;
- the cache is older than 24 hours;
- the agy version has changed;
- a model isn't in either catalog and the agy cache is more than an hour old.

The last case means a model agy added this morning resolves without a manual refresh, while a Codex typo checked against a fresh cache fails without starting agy. A refresh adds about 1.5 seconds; nothing else in routing spawns a process. The Codex catalog is a file read.

Resolution, in order:

1. `provider:model` (for example `agy:claude-opus-5-5`) selects that provider and checks the model against its catalog only.
2. An exact match in exactly one catalog selects that provider.
3. An agy catalog entry with a thinking-level suffix (`gemini-4-neon-high`) resolves to the family id plus that effort, because agy lists both forms and Claude will copy either.
4. Anything else is an error, after at most one agy catalog refresh (see the refresh rules above).

No `--model` selects the configured default model (`defaultModel` in `config.json`, else today's newest visible `gpt-*-sol`), so current Codex usage is unchanged.

Errors. Routing failures are a new `ModelUnresolved` error, exit 2 because the input is wrong, raised in the CLI before the daemon or a worktree is touched, so a typo costs nothing. With `--json` the error envelope gains an optional `candidates` field (`[{provider, model, efforts}]`) that agents can act on without parsing prose. Every message names the input as received, why it failed and the corrected command or next step, in one or two sentences:

| Case | Message |
| --- | --- |
| Near miss (edit distance ≤ 2, or a catalog id that starts with the input) | `Unknown model "gemini-4-neo": no provider lists it. Did you mean gemini-4-neon (agy)? Run foreman models to see every model.` |
| No near miss | `Unknown model "gemini-9-ultra": neither codex nor agy lists it. Run foreman models to see the available models.` |
| Listed by both providers | `Model "X" is offered by codex and agy. Pass --model codex:X or --model agy:X.` |
| Effort in the model and in `--effort` disagree | `--model gemini-4-neon-high sets effort high, but --effort is low. Use --model gemini-4-neon --effort low.` |
| Effort not valid for the provider | `--effort minimal is not valid for gemini-4-neon (agy). Use one of: low, medium, high, xhigh.` |
| `--tier` on an agy model | `--tier only applies to Codex models; gemini-4-neon runs on agy. Remove --tier.` |
| Unknown `provider:` prefix | `Unknown provider "gemni" in --model gemni:gemini-4-neon. Use codex or agy.` |
| A catalog can't be read and the input isn't in the other one | `Can't check model "gemini-4-neon": agy is unavailable (agy not found on PATH). Install agy or set AGY_BIN, then run foreman doctor.` This uses the provider whose catalog failed, or both when both failed; foreman never guesses a provider from the name to start a run |
| Hidden Codex model (present without `visibility: "list"`) | `Model "gpt-x" is in Codex's catalog but hidden. Pick a visible model from foreman models.` |

The first two cases are the ones Claude will hit, so they are the ones the tests pin. The near-miss suggestion is computed across both catalogs and includes the provider, because "did you mean gemini-4-neon (agy)" also tells Claude which provider it is about to use.

`foreman models [--json]` lists every provider's catalog: provider, model id, valid efforts, the default effort, and which model is the default. A provider that is unavailable appears with its reason instead of silently disappearing. The guide points to it, and `ModelUnresolved` messages end by naming it.

`followup` keeps the run's provider. `followup --model` is not added; a different model is a new run.

### Storage and compatibility

`run.json` gains `provider: "codex" | "agy"`, absent meaning `codex`, so every existing run reads unchanged. The field `threadId` keeps its name and holds the agy session id for agy runs; renaming it would rewrite every record for no behavior change.

Old binaries must not touch agy runs. An old daemon would decode an agy `run.json` (Schema ignores the unknown field), treat the session id as a Codex thread and fail a resume in a confusing way. 0.3.1's `StorageHeader` already accepts `formatVersion` 1 and 2 for every stored file, so version 2 would not fence it. agy runs write `formatVersion: 3` in `run.json`; the new `StorageHeader` accepts 1 to 3, and 0.3.1 rejects 3, which fences mutations across that run's files through the existing unsupported-version path. Codex runs keep writing version 1, so downgrading foreman leaves them usable.

The raw message log is `codex.jsonl` for Codex runs (unchanged) and `agy.jsonl` for agy runs. `Store.appendCodexMessage` becomes `appendProviderMessage(runDir, provider, message)`. The version checks that list `codex.jsonl` by name (`src/core/runs/store.ts:115`, `:121`) take the list of raw log names from the provider table.

The fence holds only if every save of an agy run writes version 3. `encodeStored` defaults to version 1 (`store.ts:40`), so `writeRun` derives the version from `record.provider` rather than taking a default, and a store test saves an agy record through each path that writes `run.json` (create, save, recovery's transition replay) and reads back version 3.

Events gain one tag, `Permission {kind, title, decision}`, written as version 2 lines. `Resumed` keeps its fields; for agy `sandbox` carries the mode name.

The digest and `Overview` rows gain `provider`. `tier` stays in the digest and is `null`-free: agy runs report `"n/a"`, so the existing schema needs no change and text output omits it for agy.

### Config

`config.json` adds `agyBin` beside `codexBin`, `defaultModel`, and nothing else. Environment: `AGY_BIN` (executable, default `agy`), read only in `config.ts` with schema validation, a precedence test and entries in `.env.example` and README. The daemon's `Pong` adds `agyBin`, and the client's replacement check compares it as it compares `codexBin`.

### Errors

The public error tags stay stable, because agents can match on the `--json` envelope's `error.tag` (`src/errors.ts:104-111`). `CodexUnavailable` keeps its tag, class and exit code 5 for Codex failures, so phase 0 changes no assertion on it. agy failures get a sibling `AgyUnavailable`, also exit 5 and retryable, with a table message naming agy. A shared helper builds either one from a provider id, so adapters and the supervisor never pick a tag by hand.

Cross-build cases:

- An older CLI talking to a newer busy daemon only sees `AgyUnavailable` for an agy run. An older CLI can't have started one, so that requires inspecting a run started by the newer build. It decodes as an unknown tag (`src/daemon/client.ts:203`) and renders as a daemon failure. That's acceptable and noted in the changelog.
- The CLI resolves the provider before sending `Start`. When the daemon is an outdated busy build, it refuses any `Start` whose model resolves to agy, for managed and prepared worktrees alike, with `DaemonUnavailable`: "Outdated busy daemon can't start agy runs; the request was not sent. Finish or interrupt its active runs, then retry." This matters because 0.3.1 would ignore the unknown field and start a Codex run with a Gemini model (`client.ts:402-413` only guards managed starts today).
- `app-server.ts:92` recognizes a deliberate close by comparing `error.detail` to "app server connection closed". That becomes a typed `ConnectionClosed` reason in `jsonrpc.ts`, so neither adapter depends on the wording.

Signed-out agy shows up as an error on `session/new`, inside `Start` and before `Started` returns, and becomes `AgyUnavailable` with "agy isn't signed in. Run agy once and sign in, then run foreman doctor." If a release moves the check to the first prompt instead, the turn fails, and the run's failure carries the same text. The phase 1 fake agent covers both.

`RepoHooksUntrusted` keeps its tag; its table message becomes provider-neutral and the detail carries the provider's fix. New: `ModelUnresolved` (exit 2). `CodexRpcError` and `CodexRequestTimeout` become `RpcError` and `RpcRequestTimeout` inside `jsonrpc.ts`; they never cross the daemon boundary.

### The agent experience

Claude should not need to know which provider it is on, except to pick the model and to read the review command in the contract.

The guide's core topic names both providers in one table (what each is good for, how it authenticates, its default model and efforts) and tells Claude to run `foreman models` instead of reading `models_cache.json`. Topics that describe provider behavior (questions on resume, steering, read-only strength) state the difference in one line where it applies.

The contract templates in `src/guide/contract.ts` take the provider. The instruction-loading paragraph says what that provider loads itself (Codex: AGENTS.md and its skills; agy: `GEMINI.md`, `AGENTS.md`, `.agents/rules/` and `.agents/skills/`, walking from the worktree to the repo root). The independent self-review step uses the provider's own non-interactive mode, run from the worktree root: `codex exec --ephemeral --sandbox read-only ...` for Codex, and for agy `agy -p --model <model> --output-format text < prompt.md`. agy's print mode has no read-only sandbox, so the agy review prompt says to make no edits, and phase 4's smoke case checks what print mode does with an edit or shell permission request before the template is final. `scripts/generate-skill.ts` regenerates the skill; its description says "Delegate coding work to Codex or Antigravity (Gemini) through foreman".

`foreman doctor` reports each provider separately: executable and version, sign-in (Codex: `codex login status`; agy: whether `agy models` succeeds, which creates no conversation), protocol compatibility, hook trust for the current repo and catalog size. Doctor's exit code reflects only providers that would refuse a start Claude asked for; an absent agy does not fail doctor for a Codex-only user, and is reported as "agy: not installed".

`foreman monitor` shows the provider as a short tag beside the model in list rows and detail facts. Nothing else in the TUI changes.

## Phases

Each phase ends green on `bun run check` and tags on the landing branch.

### Phase 0: Codex behind the provider contract

Demo: `bun run check` passes, the behavior tests listed under Testing pass unchanged, and a real Codex smoke run (`FOREMAN_SMOKE=1 bun run smoke`) passes on the refactored build.

Work: `providers/contract.ts` and `providers/jsonrpc.ts`; move `src/codex/` into `providers/codex/` and split decode and normalize into `codex/events.ts`; the supervisor consumes `ProviderEvent` and `QuestionCall`; `ProviderConnections` keyed by provider, with `forRun`; `cancelQuestions` calling `reject`; `provider` on `RunRecord` (always `codex` here); the provider-derived run format version; the error-tag helper; the Grit boundary rule. No agy code.

The contract is the risk in this RFC, so phase 0 gets the phase-boundary review before it tags. It's a refactor of the supervisor's hottest code, so its lanes split by layer under one contract, not by capability: transport and Codex adapter in one lane, supervisor consumption in another, storage, config and errors in a third.

### Phase 1: an agy turn end to end

Demo: `foreman start agy-hello --model gemini-4-neon --new-worktree --write --contract hello.md --wait` creates a file in the worktree and returns the hand-off. `foreman result`, `status`, `events`, `interrupt`, `followup` and `archive` work on that run. The same start with `--model gemini-3.8-flash` and no `--write` refuses an edit, records a `Permission` event and reports the run failed with the refusal message. Starting an agy run in this repo before `.agents/hooks.json` exists is refused.

Work: `schemas/acp.ts`; the agy connection, events, permissions, interrupt through `session/cancel`, and catalog; model routing with exact matches and `provider:model` (the error table lands in phase 4); `agy.jsonl`; run `formatVersion: 3` for agy runs; environment filtering; the outdated-daemon refusal; agy hook detection and the Codex-only-guards refusal; this repo's `.agents/hooks.json` and its adapter for `block-destructive.sh`; a fake ACP agent in `tests/fixtures/fake-acp-agent/` built on the fake app server's scenario runner.

### Phase 2: questions on agy

Demo: an agy run calls `ask_orchestrator`, Claude answers through `foreman answer`, and the run continues. `defer` and the timeout deferral work. Killing the MCP child while a question is held returns the run to running and makes a later answer a late answer.

Work: `foreman mcp-question`, the daemon `Ask` request, `QuestionAbandoned` handling, and the 16-minute hold smoke case.

### Phase 3: steering, budgets and resume on agy

Demo: `foreman steer` changes a running agy turn's direction, and a steer after the turn has finished becomes a follow-up. A 45-second budget interrupts and produces a hand-off. Restarting the daemon and following up resumes the session on the run's model, with the question tool intact.

Work: merged-prompt steering with the serialized steer and completion rule; budget hand-off through the hand-off permission policy; resume through `session/resume` with model reset.

### Phase 4: the agent experience

Demo: `foreman start x --model gemini-4-neo ...` fails with the near-miss message and exit 2 in under a second when the agy catalog cache is fresh. `foreman models` lists both catalogs, and `foreman doctor` reports both providers. The guide, skill and contract templates cover agy, and the monitor tags runs by provider. Claude, given only `foreman guide`, delegates one task to Neon and one to Codex in parallel and supervises both with one `wait --all`.

Work: the routing error table and `candidates`; `foreman models`; doctor; guide topics, contract templates and the regenerated skill; monitor provider tag; README and architecture updates; the remaining agy smoke cases.

Phases 2, 3 and 4 depend on phase 1. Phases 2 and 3 both change the agy connection and the supervisor's turn paths, so they run in order. Phase 4 touches the CLI, guide, doctor and monitor and runs alongside them. It owns `src/guide/topics.ts`, and phases 2 and 3 hand it their guide lines through the plan log.

## Testing

Automated tests never run inference. The fake ACP agent scripts `initialize`, `session/new|load`, prompt turns with `session/update` sequences, permission requests, MCP tool calls through a real `foreman mcp-question` child, cancel and process death, mirroring `tests/fixtures/fake-app-server/`. Recorded agy messages from the probes become schema fixtures in `tests/acp-schemas.test.ts`, as `tests/codex-schemas.test.ts` does for Codex.

Phase 0's measure is split by what a test exercises:

- Behavior tests pass unchanged: the CLI and command tests, everything that drives `makeSupervisor` through the fake app server, the daemon and monitor tests, and e2e. A changed assertion in one of these is a behavior change and goes back to the lane.
- Tests of internals that the contract moves are rewritten against the new seams with the same cases and expectations. These are the `makeAppServer` and raw `questions.receive` calls in `tests/supervisor-integration.test.ts` (around lines 375, 3376, 3636 and 4940-5128), and `tests/run-normalize.test.ts`. The phase 0 brief lists them by name, and the lane review compares their case lists before and after.

Model routing gets a table test over the error cases above, using small fixture catalogs, including a refresh-on-miss case where the second catalog read contains the model. `permissions.ts` gets a table test over every tool kind, access level and turn kind.

`bun run smoke` gains agy cases behind `FOREMAN_SMOKE=1` and a cheap model (`gemini-3.8-flash-low`): a write turn, a read-only refusal, a held question (including the 16-minute hold), an interrupt, a steer, a budget hand-off and a resume after daemon restart. It stays out of `check`, hooks and CI.

## Risks

agy's ACP surface is younger than Codex's app server and changes every release (1.5.13 fixed ACP running commands in the wrong directory). The compatibility check refuses a protocol change and warns on a version change; recorded fixtures catch shape drift in tests; the smoke suite is the check against a real agy before each foreman release that touches the adapter.

Read-only agy runs block agy's edit tools but not shell writes (see Permissions). A write through the shell is detected at turn end, not prevented.

agy's sandbox and modes change across releases; the design depends only on `default` mode asking for every edit, shell and MCP call, which the smoke suite checks each time the supported version moves.

The model catalog depends on the agy sign-in, so a model can resolve on one machine and not another. The error says which catalog was read and how old it is.

The refactor touches the supervisor's notification path, which carries most of foreman's concurrency invariants (run lock ordering, unknown-state recovery, budget arming on late notifications). Phase 0 keeps the supervisor's logic and moves only decoding; the boundary review checks the invariants listed in docs/architecture.md against the new seam.

## Open questions

How long agy holds an MCP tool call. The probe saw at least 92 seconds; the question flow assumes 15 minutes. Phase 2's smoke case settles it, and the fallback (a lower question timeout for agy runs) changes only a default.

Whether read-only agy runs are worth offering at all, given that only agy's edit tools are blocked. The RFC offers them with warnings and a failure on detected writes; the alternative is refusing `--model <agy model>` without `--write` and sending read-only work to Codex.

## Out of scope

Cross-provider follow-ups and fallback, a `--provider` flag, agy remote agents and swarms, an HTTP MCP transport for the question bridge, and using agy's Claude or GPT models as anything other than ordinary agy models.

## Review log

A devil's-advocate review against the code raised eight findings; all eight were checked against the code and accepted.

1. Phase 0 can't keep every test unchanged, because some tests call internals the contract moves. The measure now separates behavior tests, which stay unchanged, from named internal tests, which are rewritten with the same cases.
2. The event union couldn't carry minimal-decode hook enforcement, decode warnings, `Other` events or `AgentMessage`, which the monitor reads. It gained `ItemStarted` with a minimal kind, `DecodeIssue`, `Unrecognized` and `AgentMessage`.
3. The question bridge sat outside the connection, answers went through `servers.get`, a closed bridge socket left the run waiting, and the bridge could spawn a daemon. Fixes: the bridge belongs to the agy adapter, calls route through `forRun`, `QuestionAbandoned` was added, `cancelQuestions` now rejects held calls, and the bridge uses the connect-only client.
4. Synthetic turn ids made the stale-turn filter useless, and a steer racing a queued completion left agy unsupervised. Fixes: updates with no outstanding prompt get no turn stamp, steers and replies are serialized and the steer is refused after completion, and turn ids come from the persisted turn number.
5. Refusing shell in hand-off turns would end the hand-off with no text, and the files-written check counted build artifacts. Hand-off turns now allow shell, and the read-only check uses Git status.
6. The repo-hook guard arrived after the first agy write runs, the hook check read the main checkout instead of the worktree, and phase 2 spanned five capabilities. The guard moved into phase 1, hooks are found in the worktree, and phase 2 was split into questions and steering/budget/resume.
7. Renaming `CodexUnavailable` broke the `--json` tag, outdated daemons could start agy runs as Codex runs, auth failure timing was unstated, and the store hard-coded `codex.jsonl` and version 1. Fixes: tags stay stable and `AgyUnavailable` was added, agy starts on an outdated daemon are refused, auth is caught at `session/new`, and the format version derives from the provider.
8. Catalog refresh spawned agy on every miss and left a conversation behind each time. The catalog now comes from `agy models` (no conversation), refreshes only under stated conditions, and is written atomically.
