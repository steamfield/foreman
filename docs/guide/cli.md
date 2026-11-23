# Command reference

Every foreman command with its arguments, main flags and defaults, the outcomes wait reports, and what each exit code means.

Every command accepts `--json`, which prints one JSON value on stdout, and `--help`, which prints its arguments, flags, defaults, accepted states, exit codes and examples. `foreman --version` prints the version. The help text from your installed binary is the final word on flags; this page groups them for reading. All commands work the same for Codex and agy runs unless noted.

Run names are 1 to 64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit, and are global within `FOREMAN_HOME`. Durations are whole numbers with `ms`, `s`, `m` or `h`, such as `90s` or `45m`.

## Commands at a glance

| Command | Purpose |
| --- | --- |
| [`start`](#start) | Start a run in a new or prepared worktree |
| [`status`](#status) | A run's digest, this repo's runs, or every run with `--all` |
| [`monitor`](#monitor) | Live terminal view, or a snapshot |
| [`events`](#events) | Read or follow a run's stored events |
| [`wait`](#wait) | Wait for questions or turn outcomes |
| [`answer`](#answer) | Answer a question, late or as a correction |
| [`defer`](#defer) | Release a pending question without deciding it |
| [`steer`](#steer) | Change the running turn |
| [`followup`](#followup) | Start another turn on an inactive run |
| [`interrupt`](#interrupt) | Stop the active turn or cancel start preflight |
| [`result`](#result) | Digest and latest hand-off |
| [`archive`](#archive) | Archive an inactive run and clean up its worktree |
| [`doctor`](#doctor) | Check config, providers, hook trust and the daemon |
| [`models`](#models) | List each provider's models |
| [`guide`](#guide) | Print the workflow or a contract template |
| [`skill install`](#skill-install) | Install the Claude Code skill |
| [`daemon`](#daemon) | Run or stop the daemon |
| [`update`](#update) | Update foreman |
| [`mcp-question`](#mcp-question) | Internal |

## Run commands

### start

```sh
foreman start <name> (--new-worktree | --worktree <path>) --contract <file> [flags]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--new-worktree` | | Create `.claude/worktrees/<name>` on `foreman/<name>` at `HEAD` or `--from` |
| `--worktree <path>` | | Use a prepared linked worktree at its git root, inside the main checkout; never removed by foreman |
| `--from <ref>` | `HEAD` | Base for the new worktree; requires `--new-worktree` |
| `--setup <cmd>` | | Shell command run before the delegate starts; limited to 10m, or the explicit `--budget`; requires `--new-worktree` |
| `--contract <file>` | | The task contract |
| `--write` | Read-only | Full host access, commands and network with no approval prompts |
| `--model <id>` | Codex default | Picks the provider; `codex:<id>` or `agy:<id>` names it. See [providers](providers.md) |
| `--effort <level>` | `high` | Reasoning effort; agy accepts the efforts its model lists |
| `--tier <tier>` | `priority` | Codex service tier; Codex only |
| `--budget <duration>` | `60m` | Turn budget |
| `--question-timeout <duration>` | `15m` | Time before an unanswered question is deferred; capped at 100 seconds on agy |
| `--skip-deps-check` | | Skip the prepared worktree's dependency check |
| `--wait`, `--timeout <duration>` | `60m` | Wait for this run's attention after acceptance |

`--worktree` and `--new-worktree` are mutually exclusive, and one is required. Starting a name held by an inactive run archives its old records after preflight passes; active runs refuse. Returns `Started`, or `Waited` with `--wait`.

### status

```sh
foreman status [<name>] [--all]
```

A named run prints its full digest. No name prints one line per run in the current repo group, plus orphaned worktrees. `--all` lists cached live activity across every repo and can't take a name. JSON returns `Digests`, or `Overview` with `--all`. Use `wait` for outcomes instead of polling status.

### monitor

```sh
foreman monitor [<name>] [--line [--once]]
```

Opens the live terminal list, or one run's detail. `--line` streams a compact passive line; `--once` prints one update and exits. Without interactive streams, with `--json` or inside a delegate, it prints the `status --all` (or `status <name>`) snapshot. See [Watching runs](monitor.md).

### events

```sh
foreman events <name> [--after <n>] [--limit <n>] [--verbose] [--follow]
```

Reads stored events in pages of up to `--limit` (default 100), after sequence number `--after`. Text hides protocol chatter and token usage unless `--verbose`; JSON includes the whole page. `--follow` streams text until the run becomes inactive or you press Ctrl-C (exit 130), and can't be combined with `--json`. Follow is passive: without a compatible daemon it prints saved events and one note on stderr, then exits 0.

### wait

```sh
foreman wait <name>... [--after <cursor>] [--timeout <duration>]
foreman wait --all [--after <cursor>] [--timeout <duration>]
```

Waits until any named run, or with `--all` any run in the current repo group, needs attention. `--after` takes the opaque cursor from a previous `next:` line; it is not an event sequence number. Default timeout is 60 minutes. See [wait outcomes](#wait-outcomes).

### answer

```sh
foreman answer <name> <question-id> [<text> | --file <path>] [--wait] [--timeout <duration>]
```

Answers a pending question through its held call, or sends a late answer to a deferred, cancelled or superseded one. Answering an already answered id sends a correction. If another question is pending, answer that one first.

### defer

```sh
foreman defer <name> <question-id> [<note>] [--wait] [--timeout <duration>]
```

Releases a pending question so the delegate continues independent work and reports the decision under Open. Accepts only a pending question. Answer the same id later.

### steer

```sh
foreman steer <name> [<message> | --file <path>] [--wait] [--timeout <duration>]
```

Sends instructions to a `running` turn and supersedes unanswered questions. Refuses when a question is pending, and for `starting`, `waiting`, `unknown` and inactive runs. A refused steer exits 8: wait for the turn, then follow up.

### followup

```sh
foreman followup <name> [<message> | --file <path>] [--budget <duration>] [--effort <level>] [--wait] [--timeout <duration>]
```

Starts a turn on an inactive run (`idle`, `failed`, `interrupted` or `lost`) on its saved thread and worktree, keeping its provider and contract scope. `--budget` (default 60m) applies to this turn; `--effort` persists for later turns. Refuses active runs and queued answers.

### interrupt

```sh
foreman interrupt <name> [--wait] [--timeout <duration>]
```

Requests interruption of the active turn and cancels its pending questions, or cancels start preflight (which returns `Ok` without a cursor, even with `--wait`). Read `status` afterwards: the request isn't proof the writer stopped.

### result

```sh
foreman result <name>
```

Prints the digest and the latest available hand-off, naming its turn. Exits 0 even when there is no hand-off.

### archive

```sh
foreman archive <name> [--keep-worktree]
```

Archives an inactive run, preserving its records under `runs/.archive/` and freeing the name. Removes a managed worktree and branch only when the branch is the expected one, the worktree has no dirty or untracked files, and the branch has no new commits or is merged into its source ref; otherwise exits 8. `--keep-worktree` keeps them. Prepared worktrees are always kept.

`answer`, `steer` and `followup` take exactly one message argument or `--file`. Every mutation accepts `--wait`, which waits on that run only, and returns `Accepted` with a cursor (or `Waited`).

## Setup and maintenance

### doctor

```sh
foreman doctor
```

Checks config, the foreman executable, Codex login and protocol, agy install, sign-in, protocol, hook trust and model count, repo hook trust, home permissions, orphaned worktrees and the daemon build. Never starts a turn or a daemon, and never approves hooks. Exits 0 with the report even when probes fail, so read every line.

### models

```sh
foreman models
```

Lists each provider's models, their efforts and default effort, and the default model. An unavailable provider is listed with the reason.

### guide

```sh
foreman guide [<topic...>]
```

Prints the delegation workflow, or a topic: `contract`, `contract agy`, `contract tests`, `contract tests agy`, `supervise`, `review` or `recover`. Runs without a daemon or provider. An unknown topic exits 2.

### skill install

```sh
foreman skill install [--force] [--print]
```

Installs the bundled skill at `$HOME/.claude/skills/foreman/SKILL.md`. An identical file is left unchanged; a different one needs `--force` (otherwise exit 2). `--print` writes the skill to stdout without touching files.

### daemon

```sh
foreman daemon
foreman daemon stop
```

`foreman daemon` runs the supervisor in the foreground; run commands normally start it for you. If another daemon already owns the home, it exits 0. `foreman daemon stop` stops an idle daemon without starting a replacement, succeeds when none is running, and exits 8 while runs, preflight or queued answers need it.

### update

```sh
foreman update [--check]
```

Installs the latest release with the npm, bun or pnpm global install that installed foreman, checking the registry through npm. `--check` only reports. Project dependencies, `npx` and source builds get instructions instead. An idle daemon switches to the new build on the next run command.

### mcp-question

Internal. foreman attaches `foreman mcp-question --run <name>` to each agy session as the MCP server behind `ask_orchestrator`; agy starts it, and you don't run it yourself.

## Wait outcomes

`wait`, and any command run with `--wait`, ends with one of these. All exit 0 and print a cursor and a `next:` command.

| Outcome | Meaning |
| --- | --- |
| `events` | Attention: `question`, `done`, `failed`, `interrupted` or `lost`, with a digest for each reported run |
| `timeout` | No new attention before the deadline; run the printed command to continue |
| `none` | `--all` found no active runs or unseen attention in the group |

Finished, failed and interrupted turns include their hand-off when one exists. Deferred questions show in digests, including `blocked on qN` for a deferred blocker. A cursor tracks run identity as well as position, so reusing a name doesn't hide the new run's events. The timeout bounds only the attention wait, after setup and delivery.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, including every wait outcome and doctor with unavailable probes |
| 1 | Internal error |
| 2 | Invalid command, arguments or input file, including a model no provider lists |
| 3 | Invalid configuration |
| 4 | Daemon unavailable |
| 5 | Codex or agy unavailable |
| 6 | Permission denied: input files, run data, repo hooks or daemon sockets |
| 7 | Run or question not found |
| 8 | Run conflict, including a refused steer, unsafe archive cleanup, or unreadable or unsupported run data |
| 9 | Invalid worktree or missing dependencies |
| 10 | Repo hook trust not confirmed |
| 11 | Update failed: the registry check or install didn't complete |
| 130 | Interrupted |

On failure stdout is empty and the error is printed once on stderr. With `--json`, the last stderr line is a JSON error envelope; for an unknown model it includes a `candidates` list.
