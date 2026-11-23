# How it works

The daemon, provider sessions, question deferral, budgets, storage and recovery: what happens between foreman start and the hand-off.

The short version: the CLI resolves your inputs and talks to a local daemon over a Unix socket. The daemon owns every run's state and one long-lived child process per provider, and writes everything a run does to files under `FOREMAN_HOME`. The [architecture doc](https://github.com/steamfield/foreman/blob/main/docs/architecture.md) has the full design.

## The daemon

Run commands start the daemon on demand: if the socket at `$FOREMAN_HOME/foreman.sock` is missing or refuses connections, the CLI launches a detached copy of itself and waits up to 10 seconds for it. You can also run it in the foreground with `foreman daemon` for diagnostics.

One daemon owns a home at a time, enforced with an OS advisory lock on `daemon.guard.sqlite`, so `FOREMAN_HOME` must be on a local filesystem with working locks. The socket path must fit within 104 bytes. The daemon works from the home directory, so deleting the worktree you launched it from doesn't break it.

The daemon exits after 30 minutes with no busy runs and no open client connections. Active runs, start preflight and queued answers count as busy, and a long `wait` keeps it alive too. `foreman daemon stop` stops an idle daemon and refuses while any of those need it.

## Provider sessions

The daemon starts each provider's child the first time a run needs it and shares it across runs:

| Provider | Child process | Per run |
| --- | --- | --- |
| Codex | `codex app-server` | A persistent thread |
| agy | `agy acp`, launched from an empty directory under the home | A session whose working directory is the run's worktree |

Sharing saves a process per run, but if a child dies, every active run on it loses supervision and becomes `lost`. The next request that needs the provider starts a new child, and an inactive run can resume its saved thread or session as long as its worktree still exists. A resumed agy session gets the question tool and the run's model again. A resumed Codex thread can ask questions only if Codex kept the tool, so read resume warnings.

The first turn receives a shared preamble followed by your contract. On agy, foreman also asks the model to run commands in the foreground and to ask instead of waiting, because agy would otherwise background a slow command and end its turn with nothing to wake it.

foreman is agy's ACP client, so it answers every permission request itself: it allows once or rejects once, never "allow always", and records each decision as an event. Codex runs use Codex's own sandbox instead. [Providers and models](providers.md#where-the-providers-differ) compares the two.

The delegate's environment drops `CLAUDE_*`, `FOREMAN_*` and `LOG_LEVEL`, removes API key and base URL overrides (OpenAI and Codex keys for Codex; Gemini, Google and Antigravity keys for agy), and adds `STACKS_DELEGATE=1` plus `CODEX_DELEGATE=1` or `AGY_DELEGATE=1`. Worktree isolation separates git edits; it doesn't restrict a write run's access to the rest of the host.

## Questions and deferral

When the delegate calls `ask_orchestrator`, the daemon stores the question, gives it the next id in the run (`q1`, `q2`, ...), holds the call open and marks the run `waiting`. Codex gets the tool directly. agy gets it from a small MCP server, `foreman mcp-question`, that foreman attaches to each session and that relays the call to the daemon.

An answer responds on the same held call. When the question timeout passes (15 minutes by default, 100 seconds on agy because agy drops a held call after about 180), or when you run `foreman defer`, the call returns deferral instructions: carry on with independent work and safe reversible defaults within the contract, take no irreversible step on that decision, and list it under Open. foreman doesn't inspect whether the delegate follows them.

Late answers are framed with the original question text and delivered by steering a running turn, starting a follow-up on an inactive run, or queueing behind a budget hand-off. Queued answers live in memory, so after a daemon crash check the question history and resend anything undelivered.

## Budgets and hand-offs

Each working turn gets a budget (default 60 minutes). At expiry the daemon interrupts the turn, cancels pending questions and starts a read-only hand-off turn with a 10-minute budget asking the delegate to stop and report. The run ends `interrupted`. `wait` reports only the hand-off's completion, not the interrupted turn underneath it.

A hand-off is the delegate's final message for the turn, falling back to its last message. Each one is saved as `turns/<n>.md`.

## Storage

Each run lives in `$FOREMAN_HOME/runs/<name>/`:

| File | Contents |
| --- | --- |
| `run.json` | Settings, state, provider, thread or session ids, budgets and worktree metadata |
| `contract.md` | The original contract, also used for scope on later turns |
| `baseline.txt` | Git status when the run was created |
| `events.jsonl` | Numbered, normalized events (what `foreman events` reads) |
| `questions.jsonl` | Asked, deferred and resolved question history |
| `codex.jsonl` or `agy.jsonl` | Redacted provider messages for this run |
| `turns/<n>.md`, `last-message.md` | Hand-offs per turn, and the latest one |

Records are written by temporary file and rename, so a crash leaves either the old or the new version. Archived runs move to `runs/.archive/`; foreman has no command to delete archives.

Question and event lines use storage format 2, and an agy run's `run.json` uses format 3. Older foreman binaries refuse runs in those formats rather than misreading them. Codex run records stay at format 1 so a downgrade can still read them.

## Recovery

State changes are journaled before their event is published, so a crash between the two can't hide a failed or lost outcome from a waiting caller.

When a daemon starts, runs that were active become `lost` and their pending questions are cancelled. A request whose outcome foreman can't confirm parks its run in `unknown`, which keeps the worktree reserved. If the uncertainty lasts five minutes, foreman retires that provider child before releasing the run, which can make other runs on the same child `lost`. foreman prefers a reserved worktree over the risk of two writers in it.

A run that can't be loaded is logged and skipped, its files left as they are, and its name stays reserved.

## Upgrades

The CLI compares its build with the running daemon's on every run command:

| Daemon | What happens |
| --- | --- |
| Same build | The request goes through |
| Older build, idle | The CLI stops it and starts its own build |
| Older build, busy | The CLI prints a notice, keeps using it where compatible and retries later |

While an outdated daemon is busy, managed starts and `defer` are refused, and only questions it still reports as pending can be answered. Finish those runs first. Replacement follows whichever build calls, not version order, so stop polling loops that still use an old executable: they can swap a new idle daemon back to the old build.

`foreman update` installs the latest release with the npm, bun or pnpm global install that installed foreman. For a source build on macOS, copy the new binary to a new file and rename it over the old one; overwriting it in place can get it killed with exit 137. Run `foreman skill install` afterwards. See [Configuration](configuration.md) for where logs and state live.
