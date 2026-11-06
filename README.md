# foreman

foreman lets Claude Code delegate coding tasks to OpenAI's Codex in git worktrees. Claude reads progress, answers questions and sends corrections, then reviews the diff before committing. A local daemon keeps runs alive between CLI calls.

foreman drives `codex app-server` using your Codex ChatGPT login. It does not need an API key. The MCP wrapper is still pending.

## Install

You need git, a repo with a commit and [Node 26 or newer](https://nodejs.org/en/download) for the npm launcher. Install Codex **0.166.0**, the version foreman's protocol is checked against, then sign in:

```sh
npm i -g @steamfield/foreman
foreman skill install
npm i -g @openai/codex@0.166.0
codex login
foreman doctor
```

The package supplies a native binary for macOS or Linux, arm64 or x64; keep optional dependencies enabled. You can also install with `bun add -g @steamfield/foreman` or run `npx @steamfield/foreman`.

Read doctor's probes even when it exits 0. It checks config, Codex, hook trust and daemon state without starting a turn or starting or replacing the daemon. If a version-manager shim fails, set `CODEX_BIN` to the actual executable.

### Use the Claude Code skill

The binary installs its matching entry point for Claude Code:

```sh
foreman skill install
```

An identical installed file is unchanged; inspect a different copy before replacing it with `foreman skill install --force`. Other agents can read `foreman skill install --print` (or `npx @steamfield/foreman skill install --print`). Open Claude Code in the repo and ask: "Use the foreman skill to delegate this task to Codex, then review its work."

The [skill](skills/foreman/SKILL.md) requires `foreman guide` before the first command in a session. The guide ships the workflow and contract templates with the installed binary; `foreman <command> --help` owns arguments, flags, defaults, accepted states, exit codes and examples.

## One-time repo setup

Open Codex in the **main checkout** of the repo you want to delegate into:

```sh
codex
```

Trust the project if prompted. If the repo has `.codex/hooks.json`, run `/hooks` inside Codex, inspect the project hooks and approve them. Exit Codex, then run:

```sh
foreman doctor
```

Project hooks should say `trusted` or `managed`, then `foreman start will accept runs here (hook trust).` Start also validates the worktree and dependencies. Without `.codex/hooks.json`, expect `no repo hooks apply`.

Linked worktrees inside the main checkout inherit its approved hooks. Reapprove changed definitions there; hook edits in a delegated branch take effect after reaching the main checkout. foreman never approves hooks or changes Codex trust.

## Delegate and supervise

Run `foreman guide` before the first delegation in a session. It walks through writing a contract, starting a background wait, handling questions, reviewing the diff and archiving. Fill a template from `foreman guide contract`, or `foreman guide contract tests` for a test author.

Read `foreman guide supervise` when a question or correction arrives, `foreman guide review` before landing work, and `foreman guide recover` before retrying a failed run or upgrading. Use the printed `next:` command after each result. Run waits in the background so the orchestrator remains available.

A question that needs a person gets `foreman defer`; send `foreman answer` on the same id when the decision arrives. Timeout does the same after 15 minutes by default. Never bypass hook or trust refusals; ask the user. Review the diff and run the repo's gate yourself before committing. Honor instructions to leave work uncommitted.

`--budget` defaults to 60 minutes per working turn. On expiry, foreman interrupts, then requests a read-only hand-off with a separate 10-minute budget. The run ends interrupted; a later follow-up restores its configured sandbox.

## Command reference

All commands accept `--json` and `--help`. Commands below follow `foreman`; angle brackets mark values to supply. Answer, steer and followup require one message argument or `--file`.

| Command | Purpose |
| --- | --- |
| `guide [<topic>]` | Print the agent workflow, or contract, contract tests, supervise, review or recover; `--json` includes text, topics and mentioned commands |
| `skill install [--force] [--print]` | Install the bundled skill under `$HOME/.claude/skills/foreman/`, leave an identical copy unchanged, or print it for another agent |
| `start <name> --new-worktree --contract <file>` | Create a worktree and start; accepts `--from`, `--setup`, `--write`, `--model`, `--effort`, `--tier`, `--budget`, `--question-timeout`, `--skip-deps-check` |
| `start <name> --worktree <path> --contract <file>` | Use a prepared linked worktree inside the main checkout; foreman never removes it or its branch |
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

For example, this small contract limits a help edit to one file:

```sh
contract=$(mktemp /tmp/foreman-contract.XXXXXX)
cat > "$contract" <<'CONTRACT'
Clarify the doctor help description for a new user.
- May change: `src/commands/doctor.ts`
Change description text only. Read AGENTS.md and the rules it names.
Run bun run lint and bun run typecheck; inspect doctor --help.
Leave changes uncommitted. Report the change, checks and open questions.
CONTRACT
```

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
| 6 | Permission denied, including input files, run data, repo hooks, or daemon sockets |
| 7 | Run or question not found |
| 8 | Run conflict, including unreadable or unsupported run data |
| 9 | Invalid worktree or missing dependencies |
| 10 | Repo hook trust not confirmed |
| 130 | Interrupted CLI invocation |

Failures leave stdout empty and report on stderr. With `--json`, the last stderr line is an error envelope.

## Configuration, state and logs

Environment settings take precedence over `$FOREMAN_HOME/config.json`, then defaults. The file accepts only `codexBin` and `logLevel`; unknown keys make it invalid. The CLI never reads `.env`. See [.env.example](.env.example).

| Variable | Config key | Default |
| --- | --- | --- |
| `FOREMAN_HOME` | | `~/.foreman` |
| `CODEX_BIN` | `codexBin` | `codex`, resolved through `PATH` |
| `CODEX_HOME` | | `~/.codex` |
| `LOG_LEVEL` | `logLevel` | `warn`; accepts `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `none` |
| `FOREMAN_LOG_FORMAT` | | Pretty stderr; `json` selects JSON lines |
| `FOREMAN_LOG_FILE` | | No additional CLI file; overrides the daemon JSON log path when set |

Relative paths resolve from the caller's directory. Start defaults to the newest visible `gpt-*-sol` in Codex's cache (fallback `gpt-6.1-sol`), `high` effort and `priority` tier.

`FOREMAN_HOME` holds the socket, ownership files, logs and `runs/<name>/` records, with home mode `0700`. Use a local filesystem with advisory locking; the socket path must fit within 104 bytes. Question and event lines use storage format **2**; older binaries refuse those runs.

Daemon diagnostics are in `logs/daemon.jsonl`, app-server stderr in `logs/app-server.log`; both rotate past 5 MB. CLI logs use stderr and optionally `FOREMAN_LOG_FILE`. Command records use debug on success, error on failure, filtered by `LOG_LEVEL`. The [architecture doc](docs/architecture.md) details storage and the child environment, which removes API key/base overrides and adds delegate markers.

## Upgrade

Update with your installation method. For a source install, rebuild and replace the installed binary by copying to a new file in the same directory, then renaming it:

```sh
bun install
bun run build
cp dist/foreman "$HOME/.local/bin/foreman.new" && mv -f "$HOME/.local/bin/foreman.new" "$HOME/.local/bin/foreman"
```

On macOS, copying over an existing binary can get it killed (exit 137) because the kernel caches its code signature by inode.

With one CLI build in use, the next run command replaces an idle outdated daemon with that build. An outdated busy daemon keeps serving its runs; the CLI prints a notice and retries replacement on a later call after they finish. Stop polling loops that still use an older executable: they can replace an idle new daemon with the old build again.

While an outdated daemon is busy, managed starts and `defer` are refused. Answers are allowed only for questions the old daemon still reports as pending; late answers and corrections are refused. Finish its runs before using those features. `foreman daemon stop` explicitly stops an idle daemon without starting a replacement, and succeeds if none is running. It refuses while runs, preflight or queued answers need the daemon. Doctor only reports the build comparison; it does not trigger replacement.

## Build and contribute

With Bun 1.4 or newer, build from this checkout:

```sh
bun install
bun run build
./dist/foreman --version
./dist/foreman doctor
```

Install the binary on `PATH` using a new file and rename, including when replacing an earlier build:

```sh
mkdir -p "$HOME/.local/bin"
cp dist/foreman "$HOME/.local/bin/foreman.new" && mv -f "$HOME/.local/bin/foreman.new" "$HOME/.local/bin/foreman"
export PATH="$HOME/.local/bin:$PATH"
```

Keep PATH in your shell's startup file. The rename avoids the macOS issue under [Upgrade](#upgrade). `bun run dev` uses `.dev/home` for state and `logs/` for logs. `bun install` adds git hooks when lefthook is available.

Then run `foreman skill install`. To update the generated repository copy after editing `src/guide/skill.ts`, run `bun scripts/generate-skill.ts`; the test suite checks it for drift. Guide topics and contract templates also live under `src/guide/` and compile into the binary.

`bun run check` runs lint, typecheck, unit and compiled-binary e2e tests, using a fake app server. Contributor commands live in [AGENTS.md](AGENTS.md), design in [architecture](docs/architecture.md), agent guards in [harness](docs/harness.md) and releases in the [changelog](CHANGELOG.md).

### Smoke tests

After building, `FOREMAN_SMOKE=1 bun run smoke` uses your real Codex login and plan in temporary repos, with low-effort turns and daemon cleanup. Without the flag it skips. Smoke is excluded from check, hooks and CI.

Enable the question hold with `FOREMAN_SMOKE=1 FOREMAN_SMOKE_LONG=1 bun run smoke` (15-minute timeout, 16-minute hold), or use `FOREMAN_SMOKE_SHORT=1` instead of `FOREMAN_SMOKE_LONG=1` (one-minute timeout, two-minute hold). Its separate Bun config preserves the login. Typecheck with `bunx tsc --noEmit --project smoke/tsconfig.json`.

### Releasing

Bump `version` and all four platform `optionalDependencies` versions in `package.json`, then run `bun install` to update the lockfile. Commit and push a matching `vX.Y.Z` tag. The release workflow verifies the version, runs lint, typecheck, coverage and e2e, builds four platform packages and publishes them before `@steamfield/foreman`, with npm provenance. It needs the `NPM_TOKEN` repository secret.

`bun run build:npm` builds packages under `dist/npm/`; `bun run build --npm-host` builds only the host platform and main package. Inspect each generated package with `npm publish --dry-run --access public` from its directory. The main package is `dist/npm/foreman`; its manifest omits development dependencies and lifecycle scripts.

## License

MIT. See [LICENSE](LICENSE).
