# RFC 0001: forman, a supervised Codex delegate for Claude Code

Status: implemented in 0.1.0. The deviations section records where the build differs; [docs/architecture.md](../architecture.md) describes the current design. Date: 2026-11-05. Codex CLI 0.166.0.

## Summary

forman lets Claude Code start Codex agents in isolated worktrees, check on them, steer or interrupt them, and answer questions they ask mid-turn. `forman start <name> --new-worktree --setup "<install>" --contract <file> --write --wait` creates the worktree, installs dependencies and delegates in one call. One forman daemon per user owns one `codex app-server` child process and keeps every run's state on disk. The `forman` CLI talks to the daemon over a unix socket. Claude is woken by `forman wait` running as a background Bash task, which works in every Claude Code surface, the desktop app included. An MCP server wrapping the same daemon comes later.

It replaces `~/.claude/skills/codex-delegate/scripts/delegate.sh` and keeps that workflow: the contract, the delegate preamble, the fresh-process self-review and the seven-part hand-off. Authentication is the Codex CLI's own ChatGPT login. forman never reads or asks for an OpenAI API key. It strips `OPENAI_API_KEY`, `OPENAI_API_BASE` and `CODEX_API_KEY` from the inherited environment before launching Codex, including doctor probes.

## Decisions already made

These were settled with Riley before this RFC and are not reopened here.

| Topic | Decision |
| --- | --- |
| Name | `forman`, published as `@steamfield/forman` |
| Shape | Effect 4 TypeScript CLI first, MCP server later |
| Worktrees | Unit 21 replaces the earlier Claude-owned creation decision: forman creates and safely cleans its own worktrees; `--worktree` still accepts ones Claude prepared |
| Unanswered questions | Changed in 0.1.0: defer after a per-run timeout (default 15 minutes), continue independent work and keep the decision under Open; accept late answers and corrections |
| Implementation | Delegated in units through `/execute:codex` once this RFC is reviewed |

The worktree decision now follows Claude Code's Agent tool with `isolation: "worktree"`: create one worktree per delegate, remove it when it holds no work, and retain and report it when it does. This removes manual setup from delegation while keeping leftover work visible. forman performs cleanup through `archive`, after Claude reviews the result.

## What the spikes established

Two spikes ran against the real app server. Spike 1 (in the hand-off, `spike.mjs`) covered a held `ask_orchestrator` call for up to 3 minutes and a steer between tool calls. Spike 2 (`spike2.mjs`, rerun 2026-11-05 19:01 UTC) ran four threads at once on one app server, one each in the opendata main checkout, an opendata worktree, and two scratch repos. Results:

| Question | Result |
| --- | --- |
| Do repo `.codex/hooks.json` hooks run for app-server threads? | Yes. opendata's `pre-bash.sh` guard blocked `sleep 1`, and the app server emitted `hook/started` and `hook/completed` with `status: "blocked"` and the guard's feedback text |
| Do they run in a linked worktree, whose path has never been trusted? | Yes, for a worktree inside the main checkout's directory. The hook's `sourcePath` was the main checkout's `.codex/hooks.json`, `source: "project"`, although the worktree has its own copy. Either Codex resolves a linked worktree to its main checkout, or it searches parent directories for a trusted `.codex/`; the spike can't tell these apart, so forman keeps worktrees under the main checkout (see Worktree validation) |
| Does an env var set on the app-server process reach thread commands? | Yes. `CODEX_DELEGATE=1` on the child printed `CD=1` from a thread's shell |
| Does `sandbox: "danger-full-access"` work through the app server? | Yes. The thread reported `{"type":"dangerFullAccess"}` and wrote a file |
| Concurrent threads with different `cwd`? | Four ran at once with no interference |
| Steer while an `ask_orchestrator` call is held? | Accepted, but the model only acts on it after the call is answered: the steer was recorded 8 s before the answer, and both took effect together |
| Interrupt while a call is held? | The turn ends `interrupted` within 0.1 s with `items: []`, the `dynamicToolCall` item completes `failed`, and stderr logs "dynamic tool call was cancelled before receiving a response" |
| Answer a call after its turn was interrupted? | Silently dropped: no error response and no `serverRequest/resolved` notification |
| Follow-up turn after an interrupt? | Works normally |
| Token usage shape | `thread/tokenUsage/updated` carries `tokenUsage.total` and `tokenUsage.last`, each `{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}`; `total` is cumulative |
| Server requests under `approvalPolicy: "never"` | Only `item/tool/call` arrived |

Side effects: every thread starts the MCP servers from `~/.codex/config.toml` (two of Riley's failed on every thread, and `thread/start` took about 6 s while they started), and the app server warns on stderr when the directory it was started from has an untrusted `.codex/`.

From the generated 0.166.0 types: `thread/resume` has no `dynamicTools` field, and turn settings (`effort`, `sandboxPolicy`, `model`) given on `turn/start` apply "to this turn and subsequent turns". A steer can fail with `activeTurnNotSteerable` when the turn is a `review` or `compact` turn.

The unit 11 smoke suite now drives the compiled CLI against real Codex 0.166.0. It confirms delegation through wait/result/archive, a held question answered through the CLI, steer during four slow commands, interrupt while a question is pending, refusal of a cancelled question's answer, and a successful follow-up. After stopping the daemon and starting a new app server, `ask_orchestrator` remains available on the resumed thread; the actual `thread/resume` response reports `sandbox: {type: "readOnly"}` and the run's original model.

The 45-second budget interrupts a slow command, obtains a hand-off in a read-only turn and restores write access on follow-up. A nested `codex exec --ephemeral --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort=low "Reply with exactly: REVIEW-OK"` inside a write thread exits 0 and returns `REVIEW-OK`, confirming the fresh-process self-review step works. A scratch repo with unapproved project hooks is refused with `RepoHooksUntrusted` (exit 10) before a turn starts, and doctor reports that start will refuse.

The shortened question hold auto-answered after 60.004 seconds, Codex used the supplied fallback text and chosen token, and the run remained idle through the two-minute observation window. An exact steer/completion race and question holds longer than 3 minutes remain untested. The suite checks steer while commands are running and refusal after completion. The separately enabled 16-minute hold is retained for a manual run.

## Processes

```
Claude Code
  └─ forman <command>          (short-lived; `wait` runs as a background Bash task)
        │  unix socket, JSON lines
        ▼
     forman daemon             (one per user, started on demand)
        ├─ run registry, state under $FORMAN_HOME/runs/
        └─ codex app-server --listen stdio://   (child, explicit environment)
              └─ one thread per run, cwd = the run's worktree
```

### Starting and stopping the daemon

`FORMAN_HOME` defaults to `~/.forman` and holds `config.json`, the socket and lock, `runs/` and `logs/`. The CLI resolves a relative override before passing the absolute home to a spawned daemon. Development uses `.dev/home`.

Any command that needs the daemon connects to `$FORMAN_HOME/forman.sock`. If the connection fails, it spawns `forman daemon` fully detached (new session, stdin, stdout and stderr on `/dev/null`) so the calling command never waits on the daemon's output, then polls the socket for up to 10 s. Several CLIs doing this at once is normal, since Claude starts units in parallel; the daemon's own startup sorts out which one wins:

1. Hold an exclusive SQLite transaction on `$FORMAN_HOME/daemon.guard.sqlite`. SQLite supplies OS-managed advisory file locks through the built-in `node:sqlite` in both Bun and Node, without a native addon. A busy lock means another owner, so exit 0. The kernel releases ownership on process death, including SIGKILL; neither PID reuse nor a stale record delays takeover. Never remove this database, since contenders must lock the same inode. Use a local filesystem with advisory locking. `$FORMAN_HOME/daemon.lock` holds the PID for diagnostics only.
2. Remove a leftover socket file (Effect's socket server doesn't), then listen.
3. On every exit, close the listener, interrupt and join connection dispatch, then close the supervisor scope and join its workers, subprocesses, persistence and rollback finalizers. Remove the diagnostic PID record and any remaining socket path, then close the lock database. The socket server may unlink its pathname when the listener closes; ownership remains locked throughout supervisor cleanup.

The CLI spawns the daemon with its own executable: `process.execPath daemon` for the compiled binary, and `bun src/bin.ts daemon` when running from source (`bun run dev`), chosen by whether `process.execPath` is the `bun` runtime.

The daemon exits after 30 minutes with no run in `starting`, `running` or `waiting` and no open connection. It stops listening before it exits, and the CLI treats a connection reset during connect the same as no daemon. Ping and Shutdown replies each have a 10-second deadline. `daemon stop` also bounds connection acquisition to 10 seconds, then allows a separate 10 seconds for cleanup. Shutdown confirmation requires the socket and PID record to disappear and the advisory lock to become available. A Shutdown timeout is ambiguous: inspect daemon state before retrying. The client never replays a mutation after a timeout. macOS limits socket paths to 104 bytes; both caller and daemon validate the UTF-8 byte length before connecting or starting.

The daemon logs to `$FORMAN_HOME/logs/daemon.jsonl` by default (it has no terminal), and the app server's stderr goes to `$FORMAN_HOME/logs/app-server.log`. Both are rotated like the CLI log. Fatal daemon causes are recorded before the logger drains, with safe operation fields and message-free defect frames.

### The app server's environment

The daemon inherits the environment of whichever Claude session happened to start it, and the app server and every thread inherit it from the daemon. So the daemon builds the child's environment explicitly instead of passing its own through. It drops `CLAUDE_*`, `FORMAN_*` and `LOG_LEVEL`; replaces `SSH_AUTH_SOCK` with the launchd agent socket when the inherited one is missing or dead, as `delegate.sh` does for rr; and sets `CODEX_DELEGATE=1` and `STACKS_DELEGATE=1` (older stacks branches read the second). Everything else passes through. This is the only place to set thread environment: `thread/start` has no env field, and spike 2 showed the child's environment reaches thread shells.

The Codex binary is `CODEX_BIN` if set, else `codex` on `PATH`. The Codex home is `CODEX_HOME` if set, else `~/.codex`; forman reads `models_cache.json` and `config.toml` from there and never writes to it. All three are read in `config.ts`.

### Socket protocol

One JSON object per line, decoded and encoded through Schemas in `src/schemas/daemon.ts`. A request has an `id`, a `method` matching a CLI command, and params; a response has the same `id` and either `result` or a tagged error. `wait` is a long-lived request whose response arrives when the wait ends. The CLI resolves every path argument to an absolute real path (`realpath`) before sending it, because the daemon's working directory has nothing to do with the caller's.

## Runs

A run is one Codex thread working in one worktree. Claude names it (`[a-z0-9][a-z0-9._-]{0,63}`) and uses the name everywhere; the thread id is recorded for resume.

| State | Meaning |
| --- | --- |
| `starting` | Thread requested, first turn not yet started |
| `running` | A turn is in progress |
| `waiting` | A turn is in progress and at least one `ask_orchestrator` question is pending |
| `idle` | The last turn completed; the thread accepts a follow-up |
| `failed` | The last turn failed, with the error recorded |
| `interrupted` | The last turn was interrupted by Claude or by the time budget |
| `lost` | The daemon or app server went away while a turn was in progress |
| `unknown` | Execution is unconfirmed; reconcile from the next notification, or retire and join that app-server connection before marking it `lost` after 5 minutes |

`starting`, `running`, `waiting` and `unknown` are active. The rest are inactive and accept a follow-up. Only active runs block anything: a new run may reuse the name or worktree of an inactive run, in which case the old run's directory is moved to `runs/.archive/<name>-<timestamp>/`. A follow-up on an inactive run whose worktree no longer exists is refused.

State lives in `$FORMAN_HOME/runs/<name>/`:

| File | Contents |
| --- | --- |
| `run.json` | name, thread id, group, worktree, main checkout, base commit, optional `managedWorktree {branch, baseCommit, fromRef}` ownership, model, effort, sandbox, tier, budgets, state, timestamps, latest token totals |
| `contract.md` | the contract as given at `start`, copied so the digest doesn't depend on Claude's scratchpad |
| `events.jsonl` | normalized events, each with a sequence number and timestamp |
| `codex.jsonl` | bounded app-server notifications and requests, with secret-looking keys and values redacted |
| `questions.jsonl` | question history: asked, deferred and resolved (including legacy auto-answered or cancelled records) |
| `turns/<n>.md` | the final answer of turn `n`, when it produced one |
| `last-message.md` | a copy of the newest `turns/<n>.md`, the name the codex-delegate skill already reads |
| `start-mark` | an empty file touched at start, for finding files written during the run |
| `baseline.txt` | `git status` at start, for the "new since start" comparison |

`run.json` is written atomically (temp file and rename). It and raw Codex records carry `formatVersion: 1`; new question and event lines carry `formatVersion: 2`. Readers accept versions 1 and 2, treating unversioned records as version 1. Version 2 fences out older readers before decoding the new question states. An unsupported version fences the whole run against writes and appends, including startup recovery and archive cleanup. Opening a run validates existing history; the serialized writer tracks checked file identities and metadata and records its own appends, avoiding repeated scans of unchanged logs. Start refuses unreadable or unsupported names and preserves their directories. Automatic deletion applies only to unpublished staging directories that this operation created.

Question history records `Deferred {id, by: "timeout" | "orchestrator", note?, at}`. `Resolved` records use `answered`, `late`, `correction` or `superseded`, retaining legacy `auto-answered` and `cancelled`; delivered answers include `delivery: "response" | "steer" | "followup" | "queued"`. Events publish the corresponding `QuestionResolved` resolution, including `deferred`. Pending questions have an open RPC; unanswered questions are deferred questions with no subsequent resolution. CLI and daemon exchange these states only on compatible builds. An older busy daemon stays alive until its runs finish, so the CLI refuses `defer` and late answers or corrections against it; in-time answers remain supported.

State changes persist a pending transition identifier in `run.json` before appending the matching event. Startup streams the history to find that identifier, publishes missing transitions and clears completed ones without duplicating attention. Turn hand-offs and `last-message.md` also publish through temporary files and rename; readers ignore unfinished temporary files.

New wait cursors use UTF-8 with an explicit `u1.` prefix. Unprefixed legacy cursors keep their Latin-1 decoding, including paths whose bytes could also be interpreted as UTF-8.

Queued answers use a FIFO worker separate from protocol notifications, which must keep processing while a continuation waits. Outstanding answers retain the run's ownership and prevent shutdown between turns. A queued answer's cursor carries a continuation id; its delivery publishes `QuestionResolved.continuation {id, turn}`, binding that cursor to the actual receiving turn rather than an estimated turn number. This binding remains readable from event history after delivery.

Normalized events cover what the digest and `forman events` need: turn started and completed (status, error), command executions (command, exit code, status, redacted output tail), file changes (paths), agent messages, hook runs that blocked something, questions, steers and follow-ups Claude sent, token totals, and MCP startup failures. Command output tails retain their last 2 KB with best-effort redaction. Agent message deltas and reasoning items are dropped.

Diagnostic persistence keeps useful stderr, raw wire bodies and command tails while redacting secret-looking keys using the logger’s secret/password/token/authorization/cookie/API-key/access-key rules. Text redaction also covers sk- and GitHub token shapes, Bearer values, secret KEY=value assignments, complete private-key blocks within a record and long base64/hex-like blobs. Stderr tracks private-key blocks across lines per connection and replaces every block line with a redaction marker. UUID-shaped identifiers remain readable. Normalized file-change paths remain exact because scope reporting uses them as identities. Redaction is best effort: unknown credential formats can escape it, and ordinary opaque strings can be redacted. Review captures before sharing. The daemon keeps all of this under its private 0700 home, and stderr and raw capture files are created with mode 0600. Existing captures are not rewritten. There is no unrestricted wire-capture mode.

Contracts, agent messages, questions, answers and hand-offs remain private run data, even when their diagnostic text has been redacted. Preserve requested hand-offs before cleanup.

`codex.jsonl`, daemon/app-server logs and the configured CLI file sink rotate at 5 MB, keeping one `.1` file; an oversized single diagnostic record becomes an omission marker. Event pages stream committed records and stop after the requested page. Normalized events and questions retain their complete history, so archives have no automatic age or aggregate-size deletion policy.

To reclaim archives, inspect `runs/.archive/<name>-<timestamp>/`, copy any requested hand-offs (`turns/` and `last-message.md`) and needed contracts or diagnostics to the chosen retention location, then remove only the reviewed archive directory. Retain archives until their work is reviewed and those artifacts are saved; clean them manually after releases or when checking disk usage. Never include a worktree, branch, current run or unreadable run directory in archive cleanup. Unpublished `.tmp-*` directories may be inspected and removed while the daemon is stopped; they are never grounds to delete a published name.

## Commands

All commands take `--json` and then print exactly one JSON value on stdout. Without it they print short text meant for Claude to read. Every message argument also accepts `--file <path>`, since follow-up contracts are files.

`start`, `answer`, `followup`, `steer` and `interrupt` accept `--wait [--timeout <dur>]`. They send their request and then wait with the standalone wait's 60-minute default. `start --wait` prints the run name and directory, plus a created worktree's path and branch, followed by the wait result and its `next:` line. Its JSON is one `Waited` value with `started: {name, runDir, worktree, branch}` for a new worktree; the other four return the wait result directly instead of `ok`.

The daemon acknowledges `answer`, `followup`, `steer` and `interrupt` with `Accepted {cursor}`. If another run in the group is active at acceptance, it adds `all: true` and the cursor covers every run in the group; the CLI prints `next: <executable> wait --all --after <cursor>` and `--wait` uses that group. Otherwise it keeps the single-run form. Positions are captured before dispatching the mutation, so a peer completion arriving during the RPC remains visible. The target's position is captured under its lock; peers expose committed log prefixes without taking peer locks, avoiding deadlocks. Group cursors embed the main checkout, so automatic and printed waits keep the target group when invoked from another repo. Legacy position-only cursors remain readable. Without `--wait`, text is `ok` followed by `next: ...`, and JSON carries the same `next`. Shutdown keeps `Ok`.

An outdated daemon stays in service while busy. Before sending these four requests to a different build, the client captures its run position through a nonblocking `Wait`. If that build returns the older `Ok` acknowledgement, the client uses the captured cursor as `Accepted`; if it returns `Accepted`, the daemon's cursor takes precedence. Capturing before dispatch preserves immediate continuations without retrying a mutation. A daemon that cannot provide the cursor is refused before the request is sent. Managed starts are refused before dispatch to an outdated busy daemon, whose older schema could silently drop the new isolation flags; finish its runs and restart it first.

| Command | Does |
| --- | --- |
| `forman start <name> --new-worktree [--from <ref>] [--setup "<command>"] --contract <file> [--write] [--model] [--effort] [--tier] [--budget <dur>] [--question-timeout <dur>]` | Creates and validates a worktree, starts a thread with `ask_orchestrator`, sends the preamble and contract, prints the name, directory, worktree and branch, then `next: <executable> wait <name>`. Alternatively `--worktree <path>` accepts a prepared worktree |
| `forman archive <name> [--keep-worktree]` | Archives an inactive run and removes only a safe forman-created worktree and branch; `--keep-worktree` explicitly retains them |
| `forman status [<name>]` | One run's digest, or a one-line summary of every run in the current group |
| `forman events <name> [--after <seq>] [--limit <n>]` | Normalized events after a sequence number, with `gap: true` if older events were dropped |
| `forman steer <name> <message>` | `turn/steer` on the turn in progress. Refused if no turn is in progress, or if a question is pending ("answer q2 first; the answer can carry the change"), because the model won't see a steer until the question is answered |
| `forman followup <name> <message> [--budget <dur>] [--effort]` | Starts a new turn on an inactive run, resuming the thread first if this daemon didn't start it |
| `forman interrupt <name> [--wait] [--timeout <dur>]` | `turn/interrupt` on the turn in progress; acknowledges with `Accepted {cursor}` and prints `next:` to wait past earlier turns, or waits from that cursor with `--wait` |
| `forman answer <name> <question-id> <text>` | Answers a pending question; refused if the question is no longer pending |
| `forman result <name>` | The digest and the hand-off, saying which turn it came from and whether the latest turn ended without one |
| `forman wait [<name>...] [--all] [--after <cursor>] [--timeout <dur>]` | Blocks until a run needs Claude or the timeout passes; prints outcomes, digests, terminal turn hand-offs and the next wait command |
| `forman doctor` | Codex version and schema check, login state and daemon status, including its build and whether it matches this CLI |

`steer` and `followup` are separate. umum's single `message` picks steer or a new turn based on whether a turn is active, which turns a race at turn completion into a silently started turn. With two commands, losing that race is an error Claude sees.

Printed `next:` commands use `forman` only when the first executable named `forman` on the invoking CLI's inherited `PATH` resolves to the running binary by real path. Otherwise they use its absolute path, quoted for the shell when needed; source invocations include `FORMAN_HOME` so continuations from `bun run dev` keep using development state. Wait JSON carries the same command, preserving names, cursor and timeout. `doctor` reports this comparison as `formanOnPath` in JSON and as `forman on PATH is this binary` in text.

`Pong` carries the daemon's build identity. Doctor only probes it; it never replaces an outdated daemon. A running daemon's JSON has `build` and `buildMatches`; both are null when an older daemon omits its build. Text reports unknown for those values. With no daemon, it reports `not running` and starts nothing.

`start` defaults: the newest `gpt-<version>-sol` model listed in `models_cache.json` (visibility "list", no variant suffix, fallback `gpt-6.1-sol`), effort `high`, tier `priority`, `approvalPolicy: "never"`, budget 60 minutes, question timeout 15 minutes. `--write` selects `danger-full-access`; without it the sandbox is `read-only`. `workspace-write` is not offered, because the gate can't pass inside it (hand-off section 4, item 2).

`--effort` on `followup` changes the run's effort from then on, because Codex applies it to later turns too; `run.json` and the digest header follow.

### Groups

Every run belongs to a group: the main checkout of its worktree. `status` with no name and `wait --all` cover the group of the current directory's repo, so two Claude sessions in different repos never see each other's runs. Two sessions in the same repo do share a group; they can name runs explicitly to stay apart.

### Worktree validation

`--new-worktree` creates `<main checkout>/.claude/worktrees/<name>` on a new branch `forman/<name>`, from the HEAD of the repository containing the caller's current directory, or `--from <ref>`. It refuses existing paths and branches. It adds `.claude/worktrees/` to the common `.git/info/exclude` unless Git already ignores it. `--setup` runs `/bin/sh -c` in the created worktree with the app-server environment before validation or any Codex request. `--worktree <path>` remains the prepared-worktree alternative; the flags are mutually exclusive, and `--from` and `--setup` require `--new-worktree`.

Start mode validation runs before discovery or reservation; `src/core/start-mode.ts` supplies the shared validator used by the daemon. On the current wire protocol, `Start.worktree` is the source directory in managed mode and the prepared destination otherwise. Setup defaults to a ten-minute deadline. An explicit `start --budget <duration>` also sets the setup deadline, with the turn receiving its own budget of that duration afterward. `Turns.cancelStart(name)` cancels preflight without waiting for the run's name lock; interrupt dispatch must call it before looking up a registered run. Cancellation and timeout close the command scope, terminate and join its process group (escalating to SIGKILL after two seconds), then attempt rollback and release the reservation before acknowledging cancellation.

Command capture retains at most 1 MiB per output stream by default and fails visibly on overflow so Git parsers cannot consume partial output. Setup explicitly requests a 4096-byte tail per stream; failure details include an overflow note when output was discarded.

Creation and removal live in `src/core/managed-worktree.ts`, using `main-checkout.ts` and `process.ts`. The daemon holds the run's name lock through setup, validation, registration and startup. Under the registration lock it reserves the destination before creation and keeps that reservation through rollback or publication, blocking a differently named run from entering a worktree still in setup. Different runs can install concurrently. The run keeps its ownership, branch, original base commit and source ref. Branch source refs remain symbolic so archive can recognize a later merge; detached or tag bases remain commits.

Rollback tracks branch acquisition separately from successful worktree creation. It reserves the empty destination directory and records its filesystem identity before adding the worktree. A failed or interrupted add never authorizes worktree removal. Successful creation also records the `.git` file and administration directory identities and transfers this receipt to Start before leaving its interruption mask. Rollback checks those identities, the registered path and branch, and the original HEAD before removal. Dirty, replaced or advanced worktrees remain for inspection. Git removes worktrees without `--force`, and branch deletion uses the original expected OID and refuses a branch still checked out in any worktree. A failed rollback reports the retained path alongside the original failure. Cancellation acknowledges only when it won preflight, after cleanup and reservation release; a completed or rejected preflight returns false so interrupt dispatch can check the registered run.

`archive` removes a forman-created worktree and branch only with no uncommitted or untracked files and either no new commits or a tip already merged into its source branch. It also refuses when another active or starting run reserves that path, or HEAD is detached. Branch deletion uses the checked tip as its expected OID, preserving a branch that advances during removal. Otherwise `RunConflict.detail` names the path, branch, remaining work and `forman archive <name> --keep-worktree`. That option archives the record while keeping both. Passed worktrees are never removed. Named and unnamed `status`, and `doctor`, list orphan directories under `.claude/worktrees/` on `forman/*` branches with no unarchived run, including their path, branch and whether they hold work. Without trustworthy run metadata, an orphan's commits are compared conservatively with main HEAD.

`start` refuses, each with its own message, unless:

1. The path is the top level of a git worktree (`git rev-parse --show-toplevel` equals the real path).
2. It is a linked worktree: it is not the first entry of `git worktree list --porcelain`, which is the main checkout.
3. It lies inside the main checkout's directory, the only layout spike 2 showed repo hooks work for. The codex-delegate skill already puts worktrees under `<repo>/.claude/worktrees/`.
4. If it has a `package.json`, it has `node_modules` or `.pnp.cjs`, unless `--skip-deps-check` is given (for fresh scaffolds, as `DELEGATE_SKIP_DEPS_CHECK` did).
5. No active run uses the same path or name.

The main checkout, `HEAD` as the base commit, and the baseline are recorded.

### Repo hooks and trust

A delegate in a repo with `.codex/hooks.json` must not run commands without those guards. Codex loads project hooks only for trusted projects, and approves each hook by its current hash. forman never bypasses hook trust or changes trust settings.

forman checks this twice when the main checkout has a `.codex/hooks.json`:

- Before starting, `start` asks its app-server connection for `hooks/list` with `{ cwds: [worktree] }`. Codex resolves linked worktrees inside the main checkout to that checkout's hooks. Every `source: "project"` hook must have `trustStatus: "trusted"` or `"managed"`. An untrusted or modified hook, an entry with errors, or no project hooks despite the file's existence refuses the run before its files are created. An untrusted project returns only user hooks, with no warnings or errors, so the missing-project-hooks check is necessary. forman uses Codex's trust decision instead of parsing `config.toml` or recomputing hashes.
- While running, the daemon fails closed: if a `commandExecution` item starts in a turn with no `hook/started` from `source: "project"` before it, the daemon interrupts the turn and marks the run `failed` with "repo hooks did not run". That command has already started, which is the cost of not reimplementing Codex's trust logic.

The refusal names failing hook keys and their statuses. It tells the user to open Codex in the main checkout, run `/hooks` and approve the hooks (and trust the project if asked), then run `forman doctor`. Doctor uses a short app-server connection to report each project hook's trust status and whether the trust check will accept runs. Probe failures show as unknown. Repos without a hooks file skip the probe.

Because the hooks file comes from the main checkout, a branch that changes `.codex/hooks.json` doesn't take effect in its own delegate until merged.

## The question tool

Every thread registers one dynamic tool:

```json
{
  "type": "function",
  "name": "ask_orchestrator",
  "description": "Ask the orchestrator only when blocked by something the contract and code don't settle, or a decision with real consequences is needed. Progress, findings and corrections go in the hand-off: every call pauses the turn until answered. If the answer times out, proceed with best judgment and note the question and choice under Open.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" },
      "kind": { "type": "string", "enum": ["question", "blocked"] }
    },
    "required": ["question"]
  }
}
```

`kind` lets `status` tell a blocker from a question. On `item/tool/call` for this tool the daemon assigns a question id (`q1`, `q2`, ... per run), appends it to `questions.jsonl`, sets the run to `waiting`, wakes waiters, and holds the JSON-RPC request. Several questions can be pending at once if the model calls the tool in parallel; the digest lists each. `answer` replies `{success: true, contentItems: [{type: "inputText", text}]}`.

When a question's timeout passes (15 minutes by default), the daemon frees the tool call with this deferral and records `Deferred` by `timeout`:

> No answer yet; the decision may need a person and can take a while. Continue with all work that doesn't depend on it. For the question itself, take no irreversible step and nothing outside the contract; if a safe, reversible default exists, use it and say so; otherwise leave that part undone. End your turn normally and list the question, and what you did about it, under Open. The answer will arrive as a message later.

`forman defer <run> <question-id> ["note"]` frees a pending call immediately with the same text, adding `Orchestrator note: <note>` when supplied, and records `Deferred` by `orchestrator`. Deferring a non-pending question conflicts and names its state. The timeout flag and default stay unchanged. Spike 1 held a call for 3 minutes. The smoke suite has a separately enabled 15-minute timeout with a 16-minute observation window (`FORMAN_SMOKE_LONG=1`); the short case uses a one-minute timeout and two-minute observation window (`FORMAN_SMOKE_SHORT=1`). A 15-minute pending call is still unverified; the long case must pass before treating that duration as established.

When a turn ends with questions pending, they are recorded `cancelled`, because the app server cancels the call itself and drops a later answer without a word.

`forman answer <run> <question-id> "<text>"` also accepts closed questions. An answer to an already answered question is a correction. The daemon frames late answers as `Answer to your earlier question q2 ("<question text>"): <text>` and corrections as `Correction to your answer to q2 ("<question text>"): <text>`, then routes them by run state:

| Run state | Delivery |
| --- | --- |
| Another question pending | Conflict: `answer q3 first; the answer can carry this too` |
| Normal turn running | Steer; if Codex refuses, start a follow-up when the turn ends in the same command |
| Budget hand-off running | Accept and queue a follow-up after the hand-off; the acknowledgement says it is queued |
| Inactive (idle, failed, lost or interrupted) | Follow-up on the saved thread, using the usual worktree and start checks |

These commands' `--wait` and `next:` continuations target this run only. An answer queued during a hand-off waits for the answer's follow-up, rather than returning the hand-off's completion or an earlier queued answer's completion. Further answers and corrections join the same queue while older answers await delivery.

Only a newly deferred question is unanswered. An answer closes it as `late`; an explicit `steer` or `followup` closes all unanswered questions as `superseded`. Legacy `auto-answered` and `cancelled` questions never appear unanswered, but still accept late answers. Status shows `question: q2 deferred, unanswered` with its text. On completion, wait says `done, N unanswered question[s]`, or `blocked on q2` for a blocked question. Its `next:` suggests `forman answer <run> q2 "<answer>"`. On arrival of a pending question it suggests the same answer command, followed by `or: forman defer <run> q2`.

Any other dynamic tool call or server request gets a JSON-RPC error response, so nothing unexpected can hang a turn.

### Resume and the tool

Existing threads retain their original tool description. The timeout response explains deferral itself.

`thread/resume` takes no `dynamicTools`, but the unit 11 real-Codex test confirms that `ask_orchestrator` survives a daemon/app-server restart on Codex 0.166.0. The resumed thread asks a question and uses the CLI's answer in its hand-off. The captured resume response reports `sandbox: {type: "readOnly"}` and the original run model. forman passes `model`, `serviceTier`, `approvalPolicy`, `sandbox` and `cwd` from `run.json` on every resume, preventing fallback to the user's defaults. A write run also resumes with `sandbox: {type: "dangerFullAccess"}` and can write a file after restart. Every successful resume appends a `Resumed {sandbox, model}` event decoded through `ThreadOpened`; a differing sandbox produces `resumed with sandbox X, run expects Y` in the digest, using Codex policy names. There is no warning about the question tool after resume.

## `wait` and how Claude is woken

`forman wait` returns when one of the named runs (or any run in the group, with `--all`) has something newer than its cursor: a question pending, a turn completed, failed or interrupted, or the run lost. With `--all` and no active run in the group, it returns at once with `none`. Without `--after` it returns anything that happened since the run started that Claude hasn't been given a cursor past.

Each result prints a cursor line (`cursor: <opaque>`). Pending or unanswered questions suggest `next: <executable> answer <name> <question-id> "<answer>"`; pending questions also print `or: <executable> defer <name> <question-id>`. Other results, including `timeout` and `none`, end with `next: <executable> wait <same names, or --all> --after <cursor>`, preserving `--timeout <dur>` if supplied. The invoking CLI selects the executable as described above. JSON `Waited` includes `next` and an optional `alternative` for defer. The daemon keeps no per-reader state, so a `status` from another session or a `wait` killed mid-print loses nothing.

Claude starts a single delegation with `start --wait` as a background Bash task. If it asks a question, `answer <name> <id> <text> --wait` resumes and waits in one more call. A delegation needing no answer is one call; one question is two. `steer --wait` and `followup --wait` use the same loop. On timeout, run the printed `next:` command. For several units, start without `--wait` and use `forman wait --all` for the group. After a request without `--wait`, use its acknowledgement's `next:` command, whose cursor skips attention from before acceptance. Terminal outcomes carry the turn's hand-off, so reading it needs no separate `result` call. `result` remains available to reread hand-offs and can fall back to an earlier turn; wait carries null when its completed turn has no hand-off.

`wait` exits 0 whenever it returns an outcome and prints one line per run that needs attention, followed by each one's digest. `done`, `failed` and `interrupted` print `Hand-off (turn N):` and the full hand-off after that run's digest, or `No hand-off available.`. Questions retain their full text. An abbreviated example:

```
question  unit-a q2 (blocked): lint rejects the CLI-help test's runtime imports under src/
done      unit-b turn 1
cursor:   7f3a…
next: forman answer unit-a q2 "<answer>"
or: forman defer unit-a q2
```

The other first words are `failed`, `interrupted`, `lost`, `timeout` and `none`. meight's scheme (1 timeout, 2 failed, 3 question) is not used because 2 and 3 already mean usage error and invalid config in this project's error table. Claude reads a background task's output either way, so the exit code only separates "here is something" from "forman itself broke".

`--timeout` defaults to 60 minutes for background Bash tasks, which have no foreground time cap. Use `--timeout 9m` for foreground calls to stay under Claude Code's 10-minute cap.

The scaffold logs a `command` record to stderr on every run at the configured level (default `warn`), which would end every `wait` result Claude reads. forman logs it at `debug` instead, with a matching change to `docs/acceptance/typescript-cli.md` and its test.

## The digest

`status <name>`, `wait` and `result` show the same digest:

```
run:       unit-a  running  12m04s  (gpt-6.1-sol, high, priority, write)
dir:       ~/.forman/runs/unit-a
worktree:  /repo/.claude/worktrees/unit-a
branch:    forman/unit-a (forman-created, base <commit>)
turn:      2 (followup)
question:  q2 (blocked) pending 1m10s: lint rejects the CLI-help test's runtime imports under src/
commands:  84 (3 failed, 1 blocked by repo hooks)
  last:    bun run test:unit tests/cli.test.ts  exit=1
files written:  src/cli.ts, src/commands/run.ts, tests/cli.test.ts
outside May change:  (none)
new in git status since start:  ?? src/commands/run.ts
tokens:    4.1M in (96% cached), 31K out
```

Without a name, `status` prints one line per run: `unit-a  waiting  turn 2 (followup)  12m04s  q2 pending`. Each pending question gets its own marker; removed worktrees add `worktree removed`. Both status forms append orphan lines with path, branch and `holds work` or `clean`; JSON keeps `Digests` with an optional `orphans` array. The digest includes optional managed-worktree metadata and the branch/base text line. Elapsed time in the digest header and status line runs from creation to now while active, and from creation to the last state change while inactive. If there is no state-change event, the record's update time is the fallback.

Event fields come from `events.jsonl` and are cheap. The three file fields come from the worktree and are computed when a turn ends and when `status` or `result` asks, never per event:

- Files written: `find` for files newer than `start-mark`, excluding `.git` and `node_modules`, as `delegate.sh` does. This catches shell writes (formatters, codegen, installs) that `fileChange` items miss.
- New in git status: `git --no-optional-locks status --porcelain --untracked-files=all`, sorted, minus `baseline.txt` (taken the same way). `--no-optional-locks` keeps forman from taking `index.lock` while Codex runs git.
- Outside May change: the written files checked against the `- May change:` list in `contract.md`, with `delegate.sh`'s matching rules (backticked paths, a trailing `/` covers a directory, suffix matching).

A failed turn names its cause from `turn.error.message`. When `codexErrorInfo` is one of `serverOverloaded`, `rateLimitExceeded`, `policyCapacityUnavailable`, `responseStreamDisconnected`, `responseTooManyFailedAttempts` or `httpConnectionFailed`, the digest adds "transient: send a short followup like 'continue'". `usageLimitExceeded` says the plan's usage limit was reached instead. `error` notifications with `willRetry: true` are Codex's own reconnects and are recorded, not reported.

MCP startup failures are recorded as events but kept out of the digest and never treated as run failures.

## Prompt, budget and hand-off

The first turn is the delegate preamble from `delegate.sh` followed by the contract, with this tool guidance added to the preamble: "Use ask_orchestrator only when blocked by something the contract and code don't settle, or a decision with real consequences is needed. Progress, findings and corrections go in the hand-off: every call pauses the turn until answered; otherwise keep working." Follow-up turns send only Claude's message. forman doesn't own the contract templates; they stay in the codex-delegate skill.

Each turn has a budget: `--budget` on `start` for the first turn and on `followup` for later ones, default 60 minutes. When it passes, the daemon does what `delegate.sh` does on timeout instead of steering, because a steer waits behind a pending question and fails during a compaction turn:

1. Interrupt the turn, which also cancels any pending question.
2. Start a hand-off turn with `sandboxPolicy` read-only and the `delegate.sh` time-up message ("Your time is up. Stop working and run no more commands. Write the hand-off now..."), budget 10 minutes.
3. Restore the run's own sandbox policy on its next follow-up, since Codex keeps a per-turn policy for later turns.

The run ends `interrupted` with the hand-off from step 2 if one was written.

Unit 11 confirms this through the real compiled CLI: a write run with a 45-second budget is interrupted during `sleep 120`, turn 2 produces the hand-off with a captured `readOnly` policy, and turn 3 restores `dangerFullAccess` and writes a file successfully. While `restoreSandbox` is set and the hand-off turn is active, the digest reports `read-only` and its header shows `read-only (hand-off turn)`. After that turn ends, the digest again describes the run's configured sandbox; the next follow-up explicitly restores it.

The hand-off of a turn is its `agentMessage` with `phase: "final_answer"`, or its last `agentMessage` if none has that phase, written to `turns/<n>.md` and copied to `last-message.md`. An interrupted turn usually has none; `result` then shows the newest earlier hand-off and says which turn it came from.

## Failure handling

| Failure | Handling |
| --- | --- |
| Setup, preflight, hook trust or thread startup refuses a new worktree | Roll back only the worktree and branch created in that call. Setup errors carry its exit code and output tail in `WorktreeInvalid.detail`; passed worktrees remain untouched. Retain a worktree after an unconfirmed turn start even if still clean, or whenever a failed turn start leaves work; preserve the recovery state and report its path and branch in the refusal and digest warning |
| Archive finds work | Refuse with `RunConflict`, naming path, branch and remaining files or commits; `--keep-worktree` archives while retaining them, then orphan diagnostics keep them visible |
| App server exits | Log its safe termination reason once with affected run identities, persist that reason on each active run as it becomes `lost`, and cancel pending questions; the next request that needs it restarts the app server; a follow-up resumes the thread |
| Daemon exits | Same, found from `run.json` at the next daemon start |
| One run's background work fails | Log once with run identity, error tag and safe platform operation/path/reason or message-free defect frames; include the same fields for a recovery failure. An unconfirmed active turn stays `unknown` with its turn ID and worktree reservation; other failures become `failed` and wake waiters. Each run consumes its own ordered message queue, so its lock and worktree scans cannot delay other runs. Acquire run locks before the global registration lock; release registration before thread and turn RPCs. Only infrastructure failures reach the daemon's fatal worker boundary |
| Worktree removed during a turn | Completion keeps the last available worktree fields. Digests warn that the worktree was removed; the daemon and other runs continue |
| Crash during a JSONL append | Ignore the final line without a newline and truncate it before the next append. Corruption in complete records still fails that run's recovery; log its name and skip it while recovering the others |
| Crash during run creation | Build under `runs/.tmp-<name>-<random>` and publish by rename after writing `run.json`. Registry discovery ignores staging directories; Start refuses an unreadable published name and preserves all its files |
| Request times out | `thread/start` waits up to 180 s (MCP servers can take 120 s to start); other requests 30 s. A timed-out `thread/start` or `turn/start` puts the run in `unknown`, and a retry is refused while it is |
| Recording `unknown` fails | Keep the reservation and any acknowledged turn ID in memory and the five-minute recovery deadline armed. Retire and join its app server before releasing ownership, even when storage is damaged; every retirement caller waits for the shared process-resource cleanup completion, including an already-closing scope. The same connection's other active runs become lost too |
| CLI disconnects during Answer | An accepted Answer has a daemon-owned lifetime through delivery and resolution persistence. Pending calls carry their originating connection generation and cannot be answered on a replacement connection |
| Crash between state and event publication | Replay the pending transition by its identifier at startup, including inactive `lost` and `failed` records, so a continuing wait receives the outcome |
| A message fails to decode | Logged and recorded. `turn/started` and `turn/completed` fall back to a minimal decode of `threadId`, `turn.id` and `turn.status`, so a schema change can't leave a run `running` forever |
| Unknown notification or item type | Recorded as a generic event |

## Errors

New tags in `errorTable`. The error envelope gains an optional `detail` field holding text forman generates (never Codex's text), so the worktree rules and similar refusals can say which check failed.

| Tag | Exit | Covers |
| --- | --- | --- |
| `DaemonUnavailable` | 4 | The daemon could not be reached or started within 10 s |
| `CodexUnavailable` | 5 | Codex missing, schema mismatch, or a request timeout |
| `RunNotFound` | 7 | No run or question with that name or id |
| `RunConflict` | 8 | Name or worktree in use by an active run, nothing to steer, turn in progress, question pending or no longer pending, run in `unknown` |
| `WorktreeInvalid` | 9 | Any worktree rule, with `detail` naming it |
| `RepoHooksUntrusted` | 10 | The trust check in `start` |

## Protocol types and versioning

Forman identifies a build by a SHA-256 of sorted source paths and contents under `src/`, `package.json`, `bun.lock`, the build script and the Bun version. Identical inputs preserve the identity. Source invocations compute this hash at startup with a `dev-` prefix, so source edits replace dev daemons too. The CLI checks `Pong.build` with one Ping on its existing connection, reusing a Ping command's own reply; a missing field means outdated. On a mismatch, Shutdown lets an idle daemon exit before the normal spawn-on-demand path starts the caller's build. A busy daemon refuses shutdown: the command continues with one stderr notice, and a later CLI call retries replacement. A connection closed during replacement gets one handshake retry before the command is sent; commands are never replayed. Explicit shutdown stops the daemon without starting a replacement.

The generated protocol is 467 JSON Schema files (5.8 MB), too large to commit for a reference, so `src/codex/protocol.ts` records the Codex version and a SHA-256 of the `generate-json-schema --experimental` output instead (generation is deterministic; two runs were identical). `tests/fixtures/codex-0.166.0.jsonl` holds one real recorded message of each shape forman reads. The client decodes only the messages forman uses, through Schemas in `src/schemas/codex.ts`, accepting the open `string | object` arms of `CodexErrorInfo`. Codex is still `0.x`, so a version comparison says nothing about compatibility; instead the daemon regenerates the schema at startup and compares its hash. A mismatch is shown by `doctor` and in the output of every `start` until resolved.

## Testing

Unit 21 adds real-repo tests for managed creation, caller HEAD and `--from`, exclude rules, setup, refused-start rollback, safe archive and retained work, orphan diagnostics, mutually exclusive flags, and combined continuations for all four mutations. Review regressions cover old daemons, cross-repo cursors, concurrent commits, shared-path reservations and completions during a mutation. A Vitest stress case runs `bun src/bin.ts` CLI and daemon processes with the fake app server, three concurrent delegations and four bounded fault iterations (printed seed `210021`). It kills the daemon with SIGKILL and triggers scripted app-server exits at seeded request boundaries, checks the complete set of successfully started runs and independently decodes every expected run record and JSONL file, checks status and wait, and confirms every owned daemon and fake-server PID exits. It uses condition/exit waits without test sleeps and has a 59-second ceiling.

Unit and integration tests run on Node without network. The app server is replaced by a fake: a script speaking the same JSONL protocol that plays scripted turns, tool calls, hooks, token usage, interrupts and the silent drop of a late answer. That is the one fake, and it stands in for a third-party process. Tests run the daemon program in the test process with Node services, listening on a socket in a temporary data directory, and drive it through the real CLI parser.

The smoke suite, `bun run smoke`, drives `dist/forman` against the real app server and is opt-in (`FORMAN_SMOKE=1`) because it uses the user's ChatGPT login and plan. Build first with `bun run build`. Without the flag all ten real-Codex cases and five local harness regressions skip with enabling instructions; it is outside the normal gate. Cases cover delegation/wait/result/archive, question/answer, steer during slow commands and refusal after completion, interrupt with a pending question, read-only and write resume after daemon/app-server restart, budget hand-off and sandbox restoration, nested `codex exec`, and unapproved repo hooks refused before any turn. The ninth case is separately enabled as described under The question tool; unit 11 does not run the 16-minute variant. An exact steer/completion network race is not forced.

Each real-Codex case owns a short temporary data directory, scratch repo and linked worktree, stops its daemon and removes those directories even after assertion failures. These cases synchronize through the CLI's `wait`; the only sleeps are tasks given to Codex. Turns use low effort. A smoke-only pass-through Codex executable captures JSON-RPC traffic to inspect the actual resume response and turn sandbox policies. It forwards to the real installed Codex without replacing responses.

Independent review added four harness regressions: inherited stdout drains after the child exits, SIGTERM propagates correctly while stdin stays open, failed shutdown terminates an owned process tree before deleting state, and scratch Git ignores signing configuration and inherited repository selectors. They use local subprocesses and condition-based output/exit waits, without Codex turns. All four fail when their fixes are reverted and pass with the fixes, including three repeat runs. The proxy waits for closed/drained stdout and removes signal forwarding handlers before re-raising a signal. Cleanup snapshots descendants of the PID reported by the fixture's daemon, attempts the CLI stop, then uses bounded TERM/KILL fallback and confirms exit before removing state; it retains the original shutdown error. Scratch Git configuration is isolated while the Codex login home is preserved.

The runner starts Bun from `smoke/` with its own `bunfig.toml`. Using only `--config` from the repository root still merged the normal isolation preload, replaced `HOME` and hid the login, producing 401 failures. Two setup runs exposed this before the corrected runs. Smoke children also omit `OPENAI_API_KEY`, `OPENAI_API_BASE` and `CODEX_API_KEY` to keep authentication on the login. Separate cheap probes with the real home authenticated both with and without the inherited API/OAuth variables; those variables were not established as the cause of the 401.

Unit 11 results (2026-11-05 local date, Codex 0.166.0, low effort, gpt-6.1-sol): the first corrected run passed all nine cases in 407.74 seconds; the second passed eight and skipped the hold in 285.47 seconds. After review fixes, the full suite passed 12 tests (eight real-Codex cases plus four harness regressions) and skipped the hold in 145.89 seconds. Cases 1–8 passed in all three runs, with no observed flakes. Durations include setup and cleanup.

| Case | First run | Second run | After review | Observation |
| --- | --- | --- | --- | --- |
| 1. Delegation | Pass, 11.8 s | Pass, 30.2 s | Pass, 13.1 s | File content, wake hand-off, digest, result and archive agree |
| 2. Question | Pass, 18.6 s | Pass, 16.8 s | Pass, 11.3 s | Answer reaches the final hand-off |
| 3. Steer | Pass, 38.3 s | Pass, 40.0 s | Pass, 35.8 s | Four slow commands complete; final answer changes; late steer refused |
| 4. Interrupt | Pass, 37.7 s | Pass, 35.0 s | Pass, 7.5 s | Pending answer refused with exit 8; follow-up completes |
| 5. Resume | Pass, 17.7 s | Pass, 28.3 s | Pass, 8.7 s | Same thread, dynamic tool available, server reports readOnly |
| 6. Budget | Pass, 96.7 s | Pass, 72.7 s | Pass, 53.1 s | Interrupted with read-only hand-off; write restored on follow-up |
| 7. Self-review | Pass, 42.9 s | Pass, 53.7 s | Pass, 12.6 s | Nested codex exec exits 0 with REVIEW-OK |
| 8. Hook trust | Pass, 11.2 s | Pass, 8.7 s | Pass, 3.4 s | Exit 10 before a turn; doctor says start will refuse |
| 9. Short hold | Pass, 132.8 s | Skipped | Skipped | Auto-answer at 60.004 s, observation through 120 s |

The first run preceded extra assertions for the file name in the text wake, absence of commands before the question, all four completed slow commands, refusal of a late steer, and the timeout history's elapsed time. The second run includes those assertions except the separately skipped hold. The hold's recorded timestamps independently establish the elapsed time above.

## Delegation plan

0. The orchestrator writes the shared contracts first, without Codex: `src/schemas/codex.ts`, `src/schemas/daemon.ts`, the new `errors.ts` rows and envelope field, and the fake app server's script format.
1. Codex client: spawn the app server with its environment, JSON-RPC over JSONL, handshake, requests with timeouts, notifications and server requests as Effect streams; the fake app server.
2. Run store: run directory layout, atomic writes, archiving, event normalization, digest, question bookkeeping.
3. Daemon lifecycle: lock, socket, detached spawn, idle exit, registry rebuild, restart handling. Needs 0.
4. Run supervision: start and validation, trust check, hook fail-closed, questions and timeouts, budgets and the hand-off turn, resume, `wait` cursors. Needs 1, 2, 3.
5. CLI commands. Needs 4.
6. Smoke suite. Needs 5.

Units 1, 2 and 3 can run in parallel after 0.

## Deferred

The MCP server, Channels push, launchd install, a command to delete archived runs, npm publishing, and updating the codex-delegate skill to call forman (with `delegate.sh` kept as a fallback until forman has run a few real jobs).

## Open questions

1. MCP servers in delegate threads. Every thread starts the user's global Codex MCP servers, which slows `thread/start` and adds noise when they fail. Thread `config` overrides could turn them off, but some contracts may want them. This RFC leaves them on.
2. License: Apache-2.0 like stacks, or MIT like rr.

## Deviations found while building

A `thread/start` reply arriving after its timeout is discarded by the client because its request has no waiter left. The run stays `unknown` and becomes `lost` after 5 minutes. No turn was started on that thread, so it does no work.
