# forman

forman lets Claude Code delegate coding tasks to OpenAI's Codex in git worktrees. Claude reads progress, answers questions and sends corrections, then reviews the diff before committing. A local daemon keeps runs alive between CLI calls.

forman drives `codex app-server` using your Codex ChatGPT login. It does not need an API key. The MCP wrapper is still pending.

## Install

You need git, a repo with a commit and [Node 26 or newer](https://nodejs.org/en/download) for the npm launcher. Install Codex **0.166.0**, the version forman's protocol is checked against, then sign in:

```sh
npm i -g @steamfield/forman
npm i -g @openai/codex@0.166.0
codex login
forman doctor
```

The package supplies a native binary for macOS or Linux, arm64 or x64; keep optional dependencies enabled. You can also install with `bun add -g @steamfield/forman` or run `npx @steamfield/forman`.

Read doctor's probes even when it exits 0. It checks config, Codex, hook trust and daemon state without starting a turn or starting or replacing the daemon. If a version-manager shim fails, set `CODEX_BIN` to the actual executable.

### Use the Claude Code skill

Clone this repo, or use an existing checkout, and copy the skill and contract templates into your personal skills directory:

```sh
git clone https://github.com/steamfield/forman.git
cd forman
mkdir -p "$HOME/.claude/skills"
cp -R skills/forman "$HOME/.claude/skills/forman"
```

Open Claude Code in the repo and ask: "Use the forman skill to delegate this task to Codex, then review its work." The [skill procedure](skills/forman/SKILL.md) covers contracts and supervision.

## One-time repo setup

Open Codex in the **main checkout** of the repo you want to delegate into:

```sh
codex
```

Trust the project if prompted. If the repo has `.codex/hooks.json`, run `/hooks` inside Codex, inspect the project hooks and approve them. Exit Codex, then run:

```sh
forman doctor
```

Project hooks should say `trusted` or `managed`, then `forman start will accept runs here (hook trust).` Start also validates the worktree and dependencies. Without `.codex/hooks.json`, expect `no repo hooks apply`.

Linked worktrees inside the main checkout inherit its approved hooks. Reapprove changed definitions there; hook edits in a delegated branch take effect after reaching the main checkout. forman never approves hooks or changes Codex trust.

## Your first delegation

This example uses this repo, with setup complete, `forman` on `PATH` and [Bun 1.4 or newer](https://bun.sh/docs/installation) for setup and checks. Start in its main checkout with an unused name. The contract states the task, allowed edits, checks and expected report:

```sh
contract=$(mktemp /tmp/forman-contract.XXXXXX)
cat > "$contract" <<'CONTRACT'
Clarify the doctor help description for a new user.
- May change: `src/commands/doctor.ts`
Change description text only. Read AGENTS.md and the rules it names.
Run bun run lint and bun run typecheck; inspect doctor --help.
Leave changes uncommitted. Report the change, checks and open questions.
CONTRACT
forman start doctor-help --new-worktree --setup "bun install" --contract "$contract" --write --wait
```

forman creates `.claude/worktrees/doctor-help` on `forman/doctor-help` at the caller's HEAD (`--from` selects another base). Setup runs before validation or any Codex request, with a 10-minute default limit. An explicit `--budget` sets that limit too; the turn gets its own budget afterward.

`--write` gives Codex full host access, including commands and network, with your filtered inherited environment. The default is read-only.

`--wait` prints nothing until attention arrives, then returns start details with the digest and available hand-off. Run it as a background Bash task in Claude Code. Without `--wait`, start returns after starting the turn and prints a `next:` wait command.

Wait prints questions with their ids. Answer or defer the actual id; these are alternatives when `q1` is pending:

```sh
forman answer doctor-help q1 "Keep the description to one sentence." --wait
forman defer doctor-help q1 "Waiting for a person to decide." --wait
```

Deferral releases the tool call and tells Codex to continue independent work, avoid irreversible steps on the decision and list it under Open. Timeout does the same after 15 minutes by default. You can answer later, even after the turn ends.

A `done` outcome means the turn ended. Read its hand-off and inspect the work yourself:

```sh
forman result doctor-help
git -C .claude/worktrees/doctor-help diff
git -C .claude/worktrees/doctor-help status --short
```

Check new files as well as the diff. To return a review finding to Codex, send a follow-up on the inactive run:

```sh
forman followup doctor-help "Keep the help to one sentence and mention repo hook trust. Run lint and typecheck again." --wait
forman result doctor-help
```

Review the revised diff too. For this repo, run the gate and inspect the rebuilt help from the delegated worktree:

```sh
(cd .claude/worktrees/doctor-help && bun run check && ./dist/forman doctor --help)
```

Commit there and merge into the source branch when you accept the work. forman does not commit or merge for you.

After the work is merged and the worktree is clean:

```sh
forman archive doctor-help
```

Archive preserves records and frees the name. Managed cleanup requires a clean worktree with no untracked files, and a branch with no new commits or a tip merged into its source branch. Use `forman archive doctor-help --keep-worktree` to retain unfinished work. Status and doctor report existing worktrees under `<main>/.claude/worktrees/` on `forman/*` branches when no current run record refers to them. Retained worktrees elsewhere are not reported as orphans.

## Supervise a run

Names are global within `FORMAN_HOME`. Unnamed `status` and `wait --all` select the current repo and linked worktrees. Concurrent runs need separate worktrees.

| Situation | Command and behavior |
| --- | --- |
| A question is pending | `answer` responds to its held tool call; `defer` releases it without deciding |
| A deferred question needs an answer | `answer` adds the original question's context, steers a running turn or starts a follow-up on an inactive run |
| An earlier answer needs correcting | Answer the same id again; the message is framed as a correction |
| Codex refuses a late-answer steer | `answer` waits for the turn to end, then starts a follow-up |
| A budget hand-off is active | `answer` queues delivery after it; further answers stay in acceptance order |
| The active task needs a change | `steer` sends it to the running turn; answer any pending question first |
| An inactive run needs more work | `followup` continues its saved thread; it refuses while answers are queued |
| Work should stop | `interrupt` requests interruption and cancels pending questions; read the resulting state before reusing the worktree |

If a different question is pending, answer it first. Include the late answer or correction in that response. Deferred questions remain in status and wait digests until answered or superseded by explicit steer or followup. Superseded and cancelled ids still accept answers. Inactive runs need a saved thread and existing worktree to continue.

`start`, `answer`, `defer`, `steer`, `followup` and `interrupt` accept `--wait` and `--timeout`. Mutation waits target the **named run only**, even when peers are active. Start returns `Started` without waiting, or `Waited` with start metadata.

Without `--wait`, the other commands normally print `ok` and a command to wait for the run. JSON responses use `Accepted` and include a cursor; answers also identify their delivery route. With `--wait` they return `Waited`.

Interrupting start preflight instead returns `Ok`, without a cursor or wait, even with `--wait`. A queued answer's cursor tracks its own delivered turn.

Use the printed `next:` command. A question suggests `answer`, or `defer` while pending; replace the answer placeholder with your decision. Ordinary wait continuations use `--after` to avoid repeated attention and preserve an explicit timeout. A mutation without `--wait` does not carry its timeout into `next:`. Commands use `forman` if it resolves to the running executable on `PATH`, otherwise an absolute invocation, and prefix FORMAN_HOME only for a nondefault home.

`--budget` defaults to 60 minutes per working turn. On expiry, forman interrupts, then requests a read-only hand-off with a separate 10-minute budget. The run ends interrupted; the next follow-up restores its configured sandbox. A hand-off is not guaranteed if Codex or supervision fails.

## Command reference

All commands accept `--json` and `--help`. Commands below follow `forman`; angle brackets mark values to supply. Answer, steer and followup require one message argument or `--file`.

| Command | Purpose |
| --- | --- |
| `start <name> --new-worktree --contract <file>` | Create a worktree and start; accepts `--from`, `--setup`, `--write`, `--model`, `--effort`, `--tier`, `--budget`, `--question-timeout`, `--skip-deps-check` |
| `start <name> --worktree <path> --contract <file>` | Use a prepared linked worktree inside the main checkout; forman never removes it or its branch |
| `status [<name>]` | Full digest for one run, or a line per run in the group; both JSON forms return `Digests` |
| `events <name> [--after <n>] [--limit <n>] [--verbose]` | Read up to 100 stored events by default. Text hides protocol chatter and token usage unless `--verbose` is set. JSON includes every event in the selected page. |
| `answer <name> <question-id> [<text>] [--file <path>]` | Answer now, send a late answer or correct a previous answer |
| `defer <name> <question-id> [<note>]` | Release a pending question early |
| `steer <name> [<message>] [--file <path>]` | Change the running turn |
| `followup <name> [<message>] [--file <path>]` | Start another turn; accepts `--budget` and persistent `--effort` |
| `interrupt <name>` | Request interruption, including cancellation during start preflight |
| `result <name>` | Digest and latest available hand-off, naming its turn |
| `archive <name> [--keep-worktree]` | Archive an inactive run and clean up its managed worktree, or retain it explicitly |
| `wait <name>...` or `wait --all` | Wait for attention; accepts `--after <cursor>` and `--timeout <duration>` |
| `doctor` | Inspect config, Codex, hook trust, home permissions and daemon state |
| `daemon` / `daemon stop` | Run in the foreground / stop when no runs or accepted answers need the daemon |

`--worktree` and `--new-worktree` are mutually exclusive; `--from` and `--setup` require `--new-worktree`. A prepared worktree must be its git root, distinct from and inside the main checkout. With `package.json`, it needs `node_modules/` or `.pnp.cjs` unless you pass `--skip-deps-check`.

Contracts declare scope with a line beginning `- May change:` and backticked paths. Entries ending in `/` cover directory prefixes; `*` matches within a path segment and `**` across directories. Literal paths also match suffixes. The digest reports dirty paths outside that scope; this is a review aid, not a write restriction. Follow-ups keep the original contract's scope.

### Wait outcomes

Wait defaults to 60 minutes. Use a shorter foreground wait, such as `--timeout 9m`. This bounds attention waiting only; setup and mutation delivery happen before it. Durations are nonnegative whole numbers with `ms`, `s`, `m` or `h`, such as `90s` or `45m`.

| Outcome | Meaning |
| --- | --- |
| `events` | Attention: `question`, `done`, `failed`, `interrupted` or `lost`, with a digest for each reported run |
| `timeout` | No new attention before the deadline; continue with the printed command |
| `none` | `--all` has no active runs or unseen attention in the group |

All wait outcomes exit 0 and include a cursor. Completed, failed and interrupted turns include their hand-off if available. Deferred decisions appear in digests and completion summaries, including `blocked on qN` for a deferred blocker. A cursor tracks run identity as well as event position, so reusing a name does not hide a new run. Group cursors retain the repo identity across directories.

On `failed` or `lost`, read status, result, events and the worktree before continuing. `lost` means supervision was lost. Check processes and logs before resuming to avoid two writers. `unknown` reserves the worktree while execution is unconfirmed; do not retry start there. A `transient:` hint suggests a short follow-up; `usage-limit:` needs available plan capacity.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, including wait outcomes and doctor with unavailable probes |
| 1 | Internal error |
| 2 | Invalid command, arguments or input file |
| 3 | Invalid configuration |
| 4 | Daemon unavailable |
| 5 | Codex unavailable |
| 6 | Permission denied, including unreadable input files |
| 7 | Run or question not found |
| 8 | Run state conflict |
| 9 | Invalid worktree or missing dependencies |
| 10 | Repo hook trust not confirmed |
| 130 | Interrupted CLI invocation |

Failures leave stdout empty and report on stderr. With `--json`, the last stderr line is an error envelope.

## Configuration, state and logs

Environment settings take precedence over `$FORMAN_HOME/config.json`, then defaults. The file accepts only `codexBin` and `logLevel`; unknown keys make it invalid. The CLI never reads `.env`. See [.env.example](.env.example).

| Variable | Config key | Default |
| --- | --- | --- |
| `FORMAN_HOME` | | `~/.forman` |
| `CODEX_BIN` | `codexBin` | `codex`, resolved through `PATH` |
| `CODEX_HOME` | | `~/.codex` |
| `LOG_LEVEL` | `logLevel` | `warn`; accepts `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `none` |
| `FORMAN_LOG_FORMAT` | | Pretty stderr; `json` selects JSON lines |
| `FORMAN_LOG_FILE` | | No additional CLI file; overrides the daemon JSON log path when set |

Relative paths resolve from the caller's directory. Start defaults to the newest visible `gpt-*-sol` in Codex's cache (fallback `gpt-6.1-sol`), `high` effort and `priority` tier.

`FORMAN_HOME` holds the socket, ownership files, logs and `runs/<name>/` records, with home mode `0700`. Use a local filesystem with advisory locking; the socket path must fit within 104 bytes. Question and event lines use storage format **2**; older binaries refuse those runs.

Daemon diagnostics are in `logs/daemon.jsonl`, app-server stderr in `logs/app-server.log`; both rotate past 5 MB. CLI logs use stderr and optionally `FORMAN_LOG_FILE`. Command records use debug on success, error on failure, filtered by `LOG_LEVEL`. The [architecture doc](docs/architecture.md) details storage and the child environment, which removes API key/base overrides and adds delegate markers.

## Upgrade

Update with your installation method. For a source install, rebuild and replace the installed binary by copying to a new file in the same directory, then renaming it:

```sh
bun install
bun run build
cp dist/forman "$HOME/.local/bin/forman.new" && mv -f "$HOME/.local/bin/forman.new" "$HOME/.local/bin/forman"
```

On macOS, copying over an existing binary can get it killed (exit 137) because the kernel caches its code signature by inode.

With one CLI build in use, the next run command replaces an idle outdated daemon with that build. An outdated busy daemon keeps serving its runs; the CLI prints a notice and retries replacement on a later call after they finish. Stop polling loops that still use an older executable: they can replace an idle new daemon with the old build again.

While an outdated daemon is busy, managed starts and `defer` are refused. Answers are allowed only for questions the old daemon still reports as pending; late answers and corrections are refused. Finish its runs before using those features. `forman daemon stop` explicitly stops an idle daemon without starting a replacement, and succeeds if none is running. It refuses while runs, preflight or queued answers need the daemon. Doctor only reports the build comparison; it does not trigger replacement.

## Build and contribute

With Bun 1.4 or newer, build from this checkout:

```sh
bun install
bun run build
./dist/forman --version
./dist/forman doctor
```

Install the binary on `PATH` using a new file and rename, including when replacing an earlier build:

```sh
mkdir -p "$HOME/.local/bin"
cp dist/forman "$HOME/.local/bin/forman.new" && mv -f "$HOME/.local/bin/forman.new" "$HOME/.local/bin/forman"
export PATH="$HOME/.local/bin:$PATH"
```

Keep PATH in your shell's startup file. The rename avoids the macOS issue under [Upgrade](#upgrade). `bun run dev` uses `.dev/home` for state and `logs/` for logs. `bun install` adds git hooks when lefthook is available.

`bun run check` runs lint, typecheck, unit and compiled-binary e2e tests, using a fake app server. Contributor commands live in [AGENTS.md](AGENTS.md), design in [architecture](docs/architecture.md), agent guards in [harness](docs/harness.md) and releases in the [changelog](CHANGELOG.md).

### Smoke tests

After building, `FORMAN_SMOKE=1 bun run smoke` uses your real Codex login and plan in temporary repos, with low-effort turns and daemon cleanup. Without the flag it skips. Smoke is excluded from check, hooks and CI.

Enable the question hold with `FORMAN_SMOKE=1 FORMAN_SMOKE_LONG=1 bun run smoke` (15-minute timeout, 16-minute hold), or use `FORMAN_SMOKE_SHORT=1` instead of `FORMAN_SMOKE_LONG=1` (one-minute timeout, two-minute hold). Its separate Bun config preserves the login. Typecheck with `bunx tsc --noEmit --project smoke/tsconfig.json`.

### Releasing

Bump `version` and all four platform `optionalDependencies` versions in `package.json`, then run `bun install` to update the lockfile. Commit and push a matching `vX.Y.Z` tag. The release workflow verifies the version, runs lint, typecheck, coverage and e2e, builds four platform packages and publishes them before `@steamfield/forman`, with npm provenance. It needs the `NPM_TOKEN` repository secret.

`bun run build:npm` builds packages under `dist/npm/`; `bun run build --npm-host` builds only the host platform and main package. Inspect each generated package with `npm publish --dry-run --access public` from its directory. The main package is `dist/npm/forman`; its manifest omits development dependencies and lifecycle scripts.

## License

MIT. See [LICENSE](LICENSE).
