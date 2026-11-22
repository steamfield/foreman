# foreman

foreman lets Claude Code delegate coding tasks to OpenAI's Codex or to agy, Google's Antigravity CLI, in git worktrees. Claude writes a contract, starts a run, answers the delegate's questions and sends corrections, then reviews the diff before committing. A local daemon keeps runs alive between CLI calls, and `foreman monitor` gives you a live terminal view of every run on your machine.

foreman drives `codex app-server` using your Codex ChatGPT login, and `agy acp` (the Agent Client Protocol) using your agy sign-in. Neither needs an API key: foreman removes OpenAI and Gemini key variables from the delegate's environment, so a run never bills to a key by accident. The MCP wrapper is still pending.

## How it works

Claude Code is the orchestrator and Codex or agy is the delegate. You ask Claude to hand a task to Codex or Gemini; Claude does the rest through foreman commands, and you can watch.

| Term | Meaning |
| --- | --- |
| Run | One delegated task with a short unique name, such as `fix-hooks`. It has its own git worktree and branch, so it never touches your checkout. |
| Contract | The written task: the goal, the files the run may change and the files it must not. Scope is a review aid, not a sandbox. |
| Turn | One round of work in a run. Turn 1 is the start; later turns come from follow-ups or the automatic hand-off. |
| Provider | The agent that runs a delegated task: `codex` or `agy`. The model a run starts with picks it, and the run keeps it. |
| Question | The delegate pausing to ask. It waits for an answer, and after a timeout (15 minutes by default, less on agy) is deferred so the delegate continues on its best guess. A late answer is still accepted. |
| Budget | A time limit per working turn (60 minutes by default). At expiry foreman interrupts and asks for a read-only hand-off. |
| Hand-off | The summary the delegate writes when a turn ends. |
| Daemon | A local process that owns run state and the provider sessions, so a turn outlives the command that started it. |

A run is in one of these states: `starting`, `running`, `waiting` (a question needs a person), `idle` (turn finished), `failed`, `interrupted`, `lost` (supervision was lost) or `unknown`.

## Providers and models

`start --model` picks the provider by looking the model up in each provider's catalog, so a model either provider adds works without a foreman release. `foreman models` lists every model with its efforts and defaults, and shows an unavailable provider with the reason.

| Provider | Models | Sign-in | With no `--model` |
| --- | --- | --- | --- |
| `codex` | GPT models from Codex's catalog | `codex login` (ChatGPT) | `defaultModel` from config, else the newest visible `gpt-*-sol`; `high` effort, `priority` tier |
| `agy` | Gemini models, plus the other models agy lists for your account | Run `agy` once and sign in | Not used: name an agy model |

An agy id with an effort suffix, such as `gemini-4-neon-high`, means the family plus that effort, so `--model gemini-4-neon --effort high` is the same run. `--tier` applies only to Codex. When both catalogs list a model, pass `codex:<model>` or `agy:<model>`. An unknown model fails before a worktree or the daemon is touched, with exit 2, a near-miss suggestion when there is one, and with `--json` a `candidates` list.

The two providers differ in a few places:

- Read-only Codex runs use an OS sandbox. A read-only agy run refuses agy's edit tools but allows shell commands; the run carries a warning, and it fails if a shell command changed files. Use Codex when read-only must be enforced.
- agy ends its turn when foreman refuses a permission, so a refused edit in a read-only run fails the run rather than letting agy continue.
- agy holds a question's tool call for a limited time, so agy runs cap the question timeout below that hold and record the cap as a warning.
- Every other command (`wait`, `answer`, `steer`, `followup`, `interrupt`, `result`, `archive`, `monitor`) works the same on both. A follow-up stays on its run's provider.

## Watch your runs

`foreman monitor` opens a live terminal view of every run across repositories, grouped by repo and updated as work happens. Each run shows its state, task, model, activity and budget as space allows. Pending questions and attention rows sit above the groups; a preview of the selected run appears when there is room. Press Enter, or run `foreman monitor <name>`, for its contract, digest, questions, subagents, hand-off, changed files, timeline and live event feed.

```sh
foreman monitor              # every run on this machine
foreman monitor fix-hooks    # one run's detail and live feed
```

The live view opens watching, with a passive connection that does not keep the daemon alive. The first action asks you to switch to acting, which lets you answer, defer, steer, follow up, interrupt, archive and mark reviewed. Its acting connection keeps the running daemon alive while open. Press `w` to return to watching; the next action asks again. The live monitor never starts or replaces a daemon. Without a compatible running daemon it shows saved state and cannot act.

| Screen | Main keys |
| --- | --- |
| List | `↑↓` or `j`/`k` select, Enter opens or expands older idle runs, `/` filters, `!` toggles `needs:me`, `:` opens the palette, `g` cycles grouping, `h` opens history. |
| List and detail | `a` answers, `d` defers (except in Files, where it opens a diff), `s` steers, `F` follows up, `i` interrupts, `x` archives. Actions apply when the run's state allows them. |
| Answer or compose box | Enter or Ctrl-S sends, Ctrl-E opens `$EDITOR`, Esc cancels and keeps the draft. Ctrl-D defers a pending answer. Interrupt and archive have separate confirms. |
| Detail and review | Tab changes pane, `j`/`k` moves, `D` opens the tracked diff in `$PAGER`, `R` refreshes files. Use `d` on an untracked file to read its diff. In detail, `f` toggles feed follow, `1`–`5` filters the feed and `/` searches it. `r` opens review for a finished run; `r` there marks it reviewed. Esc goes back. |

`?` shows help and the legend; `q` quits when no action overlay or text input is open. For a one-row pane use `foreman monitor --line`; for a status bar use `foreman monitor --line --once` to print one update and exit. Line mode stays passive, works with redirected streams and cannot take a run name or `--json`.

Without interactive stdin and stdout, with `--json`, or inside a Codex or agy delegate, the ordinary monitor prints a snapshot: `status <name>` for a named run, otherwise `status --all`. That path may start the daemon. Agents use `status --all`, `wait` and `events`. [The design contract](docs/design/monitor.md) describes the screens and keys in full.

## Install

You need git, a repo with a commit and [Node 26 or newer](https://nodejs.org/en/download) for the npm launcher. Install Codex **0.171.0**, the version foreman's protocol is checked against, then sign in:

```sh
npm i -g @steamfield/foreman
foreman skill install
npm i -g @openai/codex@0.171.0
codex login
foreman doctor
```

The package supplies a native binary for macOS or Linux, arm64 or x64; keep optional dependencies enabled. You can also install with `bun add -g @steamfield/foreman` or run `npx @steamfield/foreman`.

Read doctor's probes even when it exits 0. It checks config, each provider, hook trust and daemon state without starting a turn or starting or replacing the daemon. If a version-manager shim fails, set `CODEX_BIN` to the actual executable.

### Add agy

agy is optional. Install the Antigravity CLI (foreman's protocol check is recorded against agy **1.5.14**), then run it once to sign in with your Google account:

```sh
agy
foreman doctor
foreman models
```

Doctor reports agy separately from Codex: the executable and version, whether `agy models` succeeds (which means you're signed in), protocol compatibility, hook trust for the current repo and the catalog size. Without agy it prints `agy: not installed` and still exits 0. Set `AGY_BIN` when `agy` isn't on `PATH`. foreman starts one `agy acp` process for all agy runs, and agy keeps each run's conversation in its own history, as Codex does.

### Use the Claude Code skill

The binary installs its matching entry point for Claude Code:

```sh
foreman skill install
```

An identical installed file is unchanged; inspect a different copy before replacing it with `foreman skill install --force`. Other agents can read `foreman skill install --print` (or `npx @steamfield/foreman skill install --print`). Open Claude Code in the repo and ask: "Use the foreman skill to delegate this task to Codex, then review its work", or name a Gemini model for agy.

The [skill](skills/foreman/SKILL.md) requires `foreman guide` before the first command in a session. The guide ships the workflow and contract templates with the installed binary; `foreman <command> --help` owns arguments, flags, defaults, accepted states, exit codes and examples.

## One-time repo setup

For Codex runs, open Codex in the **main checkout** of the repo you want to delegate into:

```sh
codex
```

Trust the project if prompted. If the repo has `.codex/hooks.json`, run `/hooks` inside Codex, inspect the project hooks and approve them. Exit Codex, then run:

```sh
foreman doctor
```

Project hooks should say `trusted` or `managed`, then `foreman start will accept runs here (hook trust).` Start also validates the worktree and dependencies. Without `.codex/hooks.json`, expect `no repo hooks apply`.

Codex loads `AGENTS.md` from the repo root down to the worktree and reads an installed skill's `SKILL.md` when a task matches its description, so contracts don't need to repeat either. Codex has no path-scoped rules. If the repo keeps Claude Code rules in `.claude/rules/`, copy this repo's [`.codex/hooks/inject-rules.ts`](.codex/hooks/inject-rules.ts) and its `apply_patch` and `PostCompact` entries in [`.codex/hooks.json`](.codex/hooks.json). It needs Bun, and sends the matching rules with Codex's first edit to a covered file. Personal skill preferences that should apply to every delegate belong in your own `~/.codex/AGENTS.md`.

Linked worktrees inside the main checkout inherit its approved hooks. Reapprove changed definitions there; hook edits in a delegated branch take effect after reaching the main checkout. foreman never approves hooks or changes Codex trust.

agy has no trust step: it runs `hooks.json` from `.agents/` (or `.agent/`, `_agents/`, `_agent/`) in the worktree it works in, so the copy that matters is the committed one. foreman refuses an agy start when that file doesn't match agy's hook schema, and when the repo has `.codex/hooks.json` but the worktree has no agy hooks, because agy would run without the repo's guards. To guard agy with the same scripts, add an `.agents/hooks.json` whose PreToolUse hooks match agy's tool names (`run_command`, `write_file`, `edit_file`), as this repo's [`.agents/hooks.json`](.agents/hooks.json) does through [`guard-adapter.sh`](.agents/hooks/guard-adapter.sh). agy reports no hook runs, so foreman can't confirm a hook ran in a turn as it does for Codex.

agy loads `GEMINI.md`, `AGENTS.md`, `.agents/rules/` and `.agents/skills/` itself, walking from the worktree to the repo root.

## Delegate and supervise

Run `foreman guide` before the first delegation in a session. It walks through writing a contract, starting a background wait, handling questions, reviewing the diff and archiving. Fill a template from `foreman guide contract`, or `foreman guide contract tests` for a test author; add `agy` (`foreman guide contract agy`) for an agy run, whose self-review runs `agy -p` instead of `codex exec`.

Read `foreman guide supervise` when a question or correction arrives, `foreman guide review` before landing work, and `foreman guide recover` before retrying a failed run or upgrading. Use the printed `next:` command after each result. Run waits in the background so the orchestrator remains available.

A question that needs a person gets `foreman defer`; send `foreman answer` on the same id when the decision arrives. Timeout does the same after 15 minutes by default. Never bypass hook or trust refusals; ask the user. Review the diff and run the repo's gate yourself before committing. Honor instructions to leave work uncommitted.

`--budget` defaults to 60 minutes per working turn. On expiry, foreman interrupts, then requests a read-only hand-off with a separate 10-minute budget. The run ends interrupted; a later follow-up restores its configured sandbox.

## Command reference

All commands accept `--json` and `--help`. Commands below follow `foreman`; angle brackets mark values to supply. Answer, steer and followup require one message argument or `--file`.

| Command | Purpose |
| --- | --- |
| `guide [<topic>]` | Print the agent workflow, or contract, contract tests (either followed by `agy` for an agy run), supervise, review or recover; `--json` includes text, topics and mentioned commands |
| `models` | List each provider's models, efforts and defaults, and any unavailable provider with its reason |
| `skill install [--force] [--print]` | Install the bundled skill under `$HOME/.claude/skills/foreman/`, leave an identical copy unchanged, or print it for another agent |
| `start <name> --new-worktree --contract <file>` | Create a worktree and start; accepts `--from`, `--setup`, `--write`, `--model`, `--effort`, `--tier`, `--budget`, `--question-timeout`, `--skip-deps-check` |
| `start <name> --worktree <path> --contract <file>` | Use a prepared linked worktree inside the main checkout; foreman never removes it or its branch |
| `status [<name>] [--all]` | Full digest for one run, or a line per run in the group (`Digests` in JSON). Use `--all` without a name for cached live activity across every repo (`Overview` in JSON); keep using `wait` for outcomes rather than polling |
| `monitor [name]` | Live terminal list or run detail; `--line [--once]` prints compact status. See [Watch your runs](#watch-your-runs). |
| `events <name> [--after <n>] [--limit <n>] [--verbose] [--follow]` | Read up to 100 stored events per page by default. Text hides protocol chatter and token usage unless `--verbose` is set. JSON includes every event in the selected page. `--follow` streams text until the run becomes inactive and all events are printed, or Ctrl-C (exit 130); it cannot be combined with `--json`. Follow connects passively and never starts, replaces or keeps a daemon alive. Without a compatible daemon it prints saved events and one stderr note explaining why follow stopped, then exits 0; `foreman status <name>` starts supervision. |
| `answer <name> <question-id> [<text>] [--file <path>]` | Answer now, send a late answer or correct a previous answer |
| `defer <name> <question-id> [<note>]` | Release a pending question early |
| `steer <name> [<message>] [--file <path>]` | Change the running turn |
| `followup <name> [<message>] [--file <path>]` | Start another turn; accepts `--budget` and persistent `--effort` |
| `interrupt <name>` | Request interruption, including cancellation during start preflight |
| `result <name>` | Digest and latest available hand-off, naming its turn |
| `archive <name> [--keep-worktree]` | Archive an inactive run and clean up its managed worktree, or retain it explicitly |
| `wait <name>...` or `wait --all` | Wait for attention; accepts `--after <cursor>` and `--timeout <duration>` |
| `doctor` | Inspect config, Codex and agy, hook trust, home permissions and daemon state |
| `daemon` / `daemon stop` | Run in the foreground / stop when no runs or accepted answers need the daemon |
| `update [--check]` | Install the latest release with the npm, bun or pnpm global install that installed this foreman; `--check` only reports. Other installs get instructions |

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
| 2 | Invalid command, arguments or input file, including a model no provider lists |
| 3 | Invalid configuration |
| 4 | Daemon unavailable |
| 5 | Codex or agy unavailable (`CodexUnavailable` or `AgyUnavailable`) |
| 6 | Permission denied, including input files, run data, repo hooks, or daemon sockets |
| 7 | Run or question not found |
| 8 | Run conflict, including unreadable or unsupported run data |
| 9 | Invalid worktree or missing dependencies |
| 10 | Repo hook trust not confirmed |
| 11 | Update failed: the registry check or the install did not complete |
| 130 | Interrupted CLI invocation |

Failures leave stdout empty and report on stderr. With `--json`, the last stderr line is an error envelope.

## Configuration, state and logs

Environment settings take precedence over `$FOREMAN_HOME/config.json`, then defaults. The file accepts only `codexBin`, `agyBin`, `defaultModel` and `logLevel`; unknown keys make it invalid. The CLI never reads `.env`. See [.env.example](.env.example).

| Variable | Config key | Default |
| --- | --- | --- |
| `FOREMAN_HOME` | | `~/.foreman` |
| `CODEX_BIN` | `codexBin` | `codex`, resolved through `PATH` |
| `AGY_BIN` | `agyBin` | `agy`, resolved through `PATH` |
| `AGY_DELEGATE` | | Unset; any nonblank value marks the process as delegated, like `CODEX_DELEGATE` |
| | `defaultModel` | Unset; a nonempty model name |
| `CODEX_HOME` | | `~/.codex` |
| `LOG_LEVEL` | `logLevel` | `warn`; accepts `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `none` |
| `FOREMAN_LOG_FORMAT` | | Pretty stderr; `json` selects JSON lines |
| `FOREMAN_LOG_FILE` | | No additional CLI file; overrides the daemon JSON log path when set |

Relative paths resolve from the caller's directory. Start defaults to `defaultModel`, else the newest visible `gpt-*-sol` in Codex's cache (fallback `gpt-6.1-sol`), with `high` effort and `priority` tier. agy runs default to `high` effort. foreman caches agy's catalog in `$FOREMAN_HOME/providers/agy/models.json` and refreshes it when it is missing, older than a day or from another agy version, or once when a model is in neither catalog and the cache is over an hour old.

`FOREMAN_HOME` holds the socket, ownership files, logs and `runs/<name>/` records, with home mode `0700`. Use a local filesystem with advisory locking; the socket path must fit within 104 bytes. Question and event lines use storage format **2**, and an agy run's `run.json` uses **3**; older binaries refuse those runs.

Daemon diagnostics are in `logs/daemon.jsonl`, app-server stderr in `logs/app-server.log` and agy's in `logs/agy-stderr.log`; these rotate past 5 MB. agy writes its own log to `logs/agy-acp.log`. CLI logs use stderr and optionally `FOREMAN_LOG_FILE`. Command records use debug on success, error on failure, filtered by `LOG_LEVEL`. The [architecture doc](docs/architecture.md) details storage and the child environment, which removes API key/base overrides and adds delegate markers.

## Upgrade

Run `foreman update` for an npm, bun or pnpm global install; it checks the registry through npm and installs the exact latest version with the same package manager (`foreman update --check` only reports). For a source install, rebuild and replace the installed binary by copying to a new file in the same directory, then renaming it:

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

Write the `CHANGELOG.md` section for the new version, then run `bun run release X.Y.Z`. It bumps `package.json` (including the four platform `optionalDependencies`), the version mentioned in `AGENTS.md` and `docs/architecture.md`, and `bun.lock`, and prints the remaining steps: `bun run check`, commit, then push `main` and a matching `vX.Y.Z` tag. The release workflow verifies the version and runs lint, typecheck, coverage and e2e while it builds the four platform packages, then a separate publish job publishes them before `@steamfield/foreman`, with npm provenance. It authenticates through npm trusted publishing, so each of the five packages needs a Trusted Publisher for `steamfield/foreman` and `release.yml`; no token is stored. [AGENTS.md](AGENTS.md#releasing) has the full procedure and recovery notes.

`bun run build:npm` builds packages under `dist/npm/`; `bun run build --npm-host` builds only the host platform and main package. Inspect each generated package with `npm publish --dry-run --access public` from its directory. The main package is `dist/npm/foreman`; its manifest omits development dependencies and lifecycle scripts.

## License

MIT. See [LICENSE](LICENSE).
