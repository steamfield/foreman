# forman

forman lets Claude Code hand coding tasks to OpenAI's Codex and supervise them while they run. Claude starts a Codex agent in a git worktree, reads its progress, steers or interrupts it, and answers questions Codex asks mid-turn. A local daemon keeps runs alive between CLI calls. forman drives `codex app-server` over JSON-RPC using your existing Codex ChatGPT login; it never needs an OpenAI API key.

## Requirements

- Node 26 or newer, Bun 1.4 or newer, and git.
- Codex CLI 0.166.0, signed in with `codex login`. This is the version forman's protocol schemas were recorded against. `forman doctor` reports protocol compatibility.
- A git repo with a commit and a linked worktree inside its main checkout. Install the delegated repo's dependencies in that worktree before starting.

## Install and build

From this checkout:

```sh
bun install
bun run build
./dist/forman --version
./dist/forman doctor
```

The binary is `dist/forman`. To use `forman` from other repos, put that binary on your `PATH`, for example:

```sh
mkdir -p "$HOME/.local/bin"
cp dist/forman "$HOME/.local/bin/forman"
export PATH="$HOME/.local/bin:$PATH"
```

Keep that `PATH` setting in your shell's startup file. Rebuild and copy the binary after updating this checkout, then run `forman daemon stop` to stop the old build. Stop refuses while any run is active and names those runs; finish or interrupt them first. With no daemon running it succeeds without starting one. The next run command starts the rebuilt daemon. npm publishing is pending. For development, `bun run dev <args>` runs from source, with separate state under `.dev/data` and logs under `logs/`. Optional lefthook git hooks install during `bun install` if lefthook is available (`brew install lefthook` on macOS).

`doctor` succeeds even when configuration or a Codex probe is unavailable, so read its output. It reports config paths, the resolved Codex executable, Codex version, protocol match, login, daemon state and repo hook trust. For a running daemon it reports `build` and `buildMatches` in JSON, with the build and its match to this CLI in text; both are unknown (null in JSON) for an old daemon without a build identity. Each probe has a 5-second execution timeout. Unavailable Codex checks are null in JSON; repo hook probe failures have state `unknown`. It never starts or replaces the daemon or starts a Codex turn.

If your Codex executable is a version-manager shim that fails in a subprocess, set `CODEX_BIN` to the actual executable path and rerun `doctor`.

## One-time repo setup

Do this once in the main checkout of each repo you delegate into:

```sh
cd /path/to/repo
codex
```

Trust the project if Codex asks. If the repo has `.codex/hooks.json`, run `/hooks` inside Codex, inspect its project hooks and approve them. Exit Codex, then check:

```sh
forman doctor
```

Each project hook should say `trusted` (or `managed`), followed by `forman start will accept runs here (hook trust).` This line checks hook trust; `start` also checks the worktree and its dependencies. Linked worktrees under the main checkout inherit its approved hooks. Approving hooks separately in each worktree is unnecessary. If you edit the main checkout's hook definitions, approve them again with `/hooks` and rerun `doctor`.

Without `.codex/hooks.json`, doctor says `no repo hooks apply` and start skips the hook trust probe. With that file present, start refuses untrusted or modified project hooks, hook loading errors, or a response with no project hooks. An untrusted project can produce that last response. The refusal names the failing keys and gives the setup steps above. forman never approves hooks or changes Codex trust settings.

Codex loads the main checkout's hooks. Hook changes made only in a delegated branch take effect after they reach the main checkout.

## Delegating a task

Claude prepares a worktree beneath the main checkout and installs its dependencies, writes a contract, then calls `forman start`. The contract should give the goal, files the delegate may change, checks to run and the expected hand-off. Runs are read-only by default; use `--write` for coding work. The default model is the newest visible `gpt-*-sol` in Codex's model cache, falling back to `gpt-6.1-sol`; effort defaults to `high`, tier to `priority`, budget to one hour and question timeout to 15 minutes.

Here is a small example in this repo. Start from its main checkout, with `forman` on `PATH` and repo setup complete. The branch and worktree names must be unused:

```sh
git worktree add -b fix-doctor .worktrees/fix-doctor
(cd .worktrees/fix-doctor && bun install)
cat > /tmp/fix-doctor-contract.txt <<'CONTRACT'
Improve the doctor help description so it mentions repo hook trust.
May change: src/commands/doctor.ts only.
Run: bun run lint and bun run typecheck.
Leave changes uncommitted. Report the change and check results.
CONTRACT
forman start fix-doctor --worktree .worktrees/fix-doctor --contract /tmp/fix-doctor-contract.txt --write --wait
```

Run `start --wait` as one background task so Claude can keep working while the delegate runs. It starts the turn, then waits with the same 60-minute default and `--timeout` option as `wait`. Text prints the run name and directory followed by the wait result and its `next:` line. JSON is one `Waited` value with `started: {name, runDir}` alongside the outcome. Without `--wait`, `start` returns immediately and ends with `next: <executable> wait <name>`. The executable is `forman` when that name on `PATH` resolves to this binary, or the running executable's absolute path otherwise; `doctor` reports the comparison. To watch several runs, use `wait --all`: it covers the repo containing the current directory, including its linked worktrees.

When wait returns, read each run's outcome and digest. A `done`, `failed` or `interrupted` outcome includes that turn's hand-off, or says no hand-off is available. A `question` includes the full text and question id; `answer` resumes the held tool call. Use `steer` to change an active turn with no pending question, `followup` to start another turn on an inactive run, and `result` to reread the available hand-off. For example, these are alternatives at the appropriate run state:

```sh
forman answer fix-doctor q1 "Keep the description to one sentence." --wait
forman steer fix-doctor "Mention that doctor reports unknown if Codex is unavailable." --wait
forman followup fix-doctor "Also check the help output manually." --wait
forman result fix-doctor
```

`answer`, `steer` and `followup` print `ok` and `next: <executable> wait <name> --after <cursor>`. Their acknowledgement cursor is captured when the request is accepted, so the wait sees the next outcome without replaying earlier attention. Add `--wait` to return that outcome directly instead of `ok`; `--timeout` sets the wait limit. A task needing no answer takes one call (`start --wait`); one question takes two (`start --wait`, `answer --wait`).

For a busy older daemon that only acknowledges with `Ok`, the CLI captures its cursor before sending the request, so an immediate continuation is still observed. This compatibility probe adds no CLI call.

On a timeout or when continuing to watch, run the final `next:` command. It includes the run names or `--all`, the cursor that prevents repeated attention, and your explicit `--timeout` if given. Review the hand-off and diff before committing; forman does not commit or merge for you.

After merging a run's work, remove its worktree, then archive the inactive run to remove it from status:

```sh
git worktree remove .worktrees/fix-doctor
forman archive fix-doctor
```

Archive prints the destination under `runs/.archive/<name>-<timestamp>/`, preserves the run's records and frees its name for reuse. Status, wait and result still work after worktree removal, with a warning and the last computed file fields (or uncomputed fields after a daemon restart).

## Commands

All commands accept `--json` for one schema-encoded result. Messages for `steer`, `followup` and `answer` come from exactly one positional argument or `--file <path>`. `start`, `steer`, `followup` and `answer` accept `--wait [--timeout <dur>]` to wait in the same call. Without `--wait`, the last three return `Accepted` with `cursor` and `next` in JSON; `interrupt` keeps its `Ok` acknowledgement.

| Command | What it does |
| --- | --- |
| `forman start <name> --worktree <path> --contract <file>` | Send the contract text and real worktree path; accepts `--write`, `--model`, `--effort`, `--tier`, `--budget`, `--question-timeout`, `--skip-deps-check` |
| `forman status [<name>]` | Print one run's digest or one line per run in the current group |
| `forman events <name> [--after <n>] [--limit <n>]` | Print normalized events and the next sequence number |
| `forman steer <name> [<message>] [--file <path>]` | Send a change to the active turn |
| `forman followup <name> [<message>] [--file <path>] [--budget <dur>] [--effort <e>]` | Start another turn |
| `forman interrupt <name>` | Interrupt the active turn |
| `forman answer <name> <question-id> [<text>] [--file <path>]` | Answer a pending question |
| `forman result <name>` | Print the digest and available hand-off, naming its turn |
| `forman archive <name>` | Move an inactive run to the archive, remove it from status and print the archive path |
| `forman wait [<name>...] [--all] [--after <cursor>] [--timeout <dur>]` | Wait for attention, print summaries, digests and turn hand-offs, then the next wait command |
| `forman doctor` | Inspect local configuration, Codex, repo hook trust and daemon availability |
| `forman daemon` | Run the daemon in the foreground; normally started automatically |
| `forman daemon stop` | Stop the daemon when no runs are active; succeeds if none is running |

## Wait outcomes and exit codes

Wait defaults to 60 minutes for background tasks. Pass `--timeout 9m` when running it in the foreground, below Claude Code's 10-minute foreground cap. Durations are nonnegative whole numbers with `ms`, `s`, `m` or `h`, such as `90s` and `45m`.

| Wait outcome | Meaning |
| --- | --- |
| `events` | A run needs attention: `question`, `done`, `failed`, `interrupted` or `lost`; each includes a digest |
| `timeout` | Nothing needed attention within the timeout; run the printed next command |
| `none` | `--all` has no active runs or unseen attention in this repo |

All three outcomes exit 0. `done` means the turn ended; assess its hand-off and checks before accepting the work. `lost` means the daemon cannot supervise the run. Every wait returns a cursor and ends with `next: <executable> wait ...`, including timeout and none; JSON includes the same command in `next`. `wait` needs run names or `--all`.

Unnamed status lists each run's name, state, turn number and kind, elapsed time, pending question ids (`q2 pending`) and a `worktree removed` marker when applicable. Named status keeps the full digest; both JSON forms return `Digests`. Elapsed time runs from creation to now for active runs, and to the last state change for inactive runs.

| Exit code | Meaning |
| --- | --- |
| 0 | Success, including all wait outcomes and doctor with unavailable probes |
| 1 | Internal error |
| 2 | Invalid command or arguments |
| 3 | Invalid configuration |
| 4 | Daemon unavailable |
| 5 | Codex unavailable |
| 6 | Permission denied |
| 7 | Run or question not found |
| 8 | Run state conflict |
| 9 | Invalid worktree or missing dependencies |
| 10 | Repo hook trust not confirmed |
| 130 | Interrupted CLI invocation |

Failures leave stdout empty and report once on stderr. With `--json`, the final stderr line is an error envelope. Successful `command` log records use debug level and failures use error level; the configured minimum level filters both.

## Configuration

Settings come from environment variables, then the optional file `$XDG_CONFIG_HOME/forman/config.json` (default `~/.config/forman/config.json`), then defaults. The CLI never reads `.env`; `.env.example` lists the variables.

| Variable | Config key | Default | Meaning |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `logLevel` | `warn` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `none` |
| `FORMAN_LOG_FORMAT` | | pretty | `json` writes stderr logs as JSON lines |
| `FORMAN_LOG_FILE` | | none | Also append JSON log records to this file |
| `FORMAN_DATA_DIR` | | `$XDG_DATA_HOME/forman` (`~/.local/share/forman`) | Where forman keeps its state |
| `CODEX_BIN` | `codexBin` | `codex` | Codex executable; resolved through `PATH` |
| `CODEX_HOME` | | `$HOME/.codex` | Codex configuration and state directory |

The config file is closed: an unknown key makes it invalid, which `doctor` reports.

Relative `FORMAN_DATA_DIR`, `FORMAN_LOG_FILE`, `CODEX_HOME` and executable paths in `CODEX_BIN` resolve from the caller's directory. Bare executable names such as `codex` use `PATH`.

forman uses the Codex CLI's ChatGPT login and never passes API key variables from the caller's environment to Codex.

## State and logs

`FORMAN_DATA_DIR` defaults to `$XDG_DATA_HOME/forman` or `~/.local/share/forman`. It holds `forman.sock`, the daemon lock, and `runs/<name>/` with the run record, contract, normalized events, question history, raw Codex traffic and `turns/<n>.md` hand-offs. Replacing an inactive run archives its previous directory under `runs/.archive/`. Names are global within the data directory; status without a name and wait with `--all` select the current repo's group.

The daemon runs from the data directory, so removing the worktree that launched it does not prevent later app-server starts. At startup it creates or tightens the data directory to mode `0700`, restricting access to its owner.

The daemon starts automatically when a run command needs it and exits after 30 idle minutes. `logs/daemon.jsonl` and `logs/app-server.log` under the data directory hold daemon diagnostics and app-server stderr, rotated past 5 MB. Setting `FORMAN_LOG_FILE` overrides the daemon JSON log path, including for development runs; app-server stderr stays in `logs/app-server.log`. CLI logs go to stderr and optionally the same `FORMAN_LOG_FILE`. Development runs also append `logs/cli.jsonl` and `logs/cli.log` in this checkout.

## Architecture and tests

`src/bin.ts` supplies Bun platform services. `src/main.ts` runs the Effect CLI tree in `src/cli.ts`, maps errors to exit codes and renders output once. Thin handlers in `src/commands/` call platform-free programs in `src/core/`. Boundary shapes live in `src/schemas/`, and application services in `src/services/`.

| Directory | Responsibility |
| --- | --- |
| `src/codex/` | App-server JSON-RPC connection, protocol and environment checks |
| `src/core/preflight/` | Worktree validation, repo hook trust, model selection and SSH probe |
| `src/core/runs/` | Run persistence, event normalization, worktree changes and digests |
| `src/daemon/` | Local socket client/server, startup and ownership lock |
| `src/supervisor/` | App-server lifetime, turns, questions, budgets, hook enforcement and wait cursors |

Vitest runs on Node, with real services, temporary git repos and a scripted fake Codex app server. Recorded Codex 0.166.0 messages check the wire schemas. `e2e/` tests the compiled binary with Bun's runner and a clean environment. The agent harness is described in [docs/harness.md](docs/harness.md).

### Smoke tests

Run `bun run build`, then `FORMAN_SMOKE=1 bun run smoke` to exercise the compiled binary against real Codex using your ChatGPT login and plan. It includes nine real-Codex cases and four local harness regressions; without the variable all 13 tests skip. Tasks use low effort, isolated temporary repos and data directories, and stop their daemons during cleanup. The smoke environment drops API key and API base overrides so it uses the login. CLI transcripts and case durations print to stdout; redirect them to a file to keep a record.

The long question hold is separately enabled with `FORMAN_SMOKE=1 FORMAN_SMOKE_LONG=1 bun run smoke` (15-minute timeout, 16-minute hold). Use `FORMAN_SMOKE_SHORT=1` instead of `FORMAN_SMOKE_LONG=1` for a one-minute timeout and two-minute hold. Smoke tests use their own Bun config to preserve the real login. They are a development tool for checking forman against real Codex (after a Codex upgrade, say), never part of automated testing: `bun run check`, git hooks and CI run only against the fake app server and must not run real inference. Their TypeScript can be checked with `bunx tsc --noEmit --project smoke/tsconfig.json`.

| Script | What it does |
| --- | --- |
| `bun run dev <args>` | Run from source with development state and logs |
| `bun run lint` | Biome checks |
| `bun run format` | Biome formatting and safe fixes |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` / `bun run test:unit [file]` | Vitest on Node, optionally selected files |
| `bun run coverage` | Unit suite with coverage |
| `bun run e2e` | Build, then test the compiled binary |
| `bun run build` | Compile `dist/forman` |
| `bun run check` | lint, typecheck, test and e2e |
| `bun run clean` | Remove build, test and log output |

The MCP wrapper, npm publishing and release workflow are pending.

## License

To be decided.
