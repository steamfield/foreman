# forman

forman lets Claude Code hand coding tasks to OpenAI's Codex and supervise them while they run. Claude starts a Codex agent in a git worktree, checks on it, steers or interrupts it, and answers questions Codex asks mid-turn. forman drives `codex app-server` and uses your existing Codex login (a ChatGPT plan); it never needs an OpenAI API key.

The CLI commands and socket transport are implemented. The daemon command and real request handler are still pending.

## Getting started

You need Node 26 or newer, Bun 1.4 or newer, git, and the Codex CLI signed in with `codex login`. lefthook is optional and installs the git hooks.

```sh
bun install
bun run build
./dist/forman doctor
```

`doctor` prints the version, platform, config paths and validity, Codex version, protocol hash match, login state, and daemon state. Unavailable Codex checks show null in JSON. It succeeds even when checks are unavailable or configuration is broken, and never starts the daemon. Each diagnostic probe has a 5-second execution timeout.

## Commands

All commands accept `--json` for one schema-encoded result. Messages for `steer`, `followup` and `answer` come from exactly one positional argument or `--file <path>`.

| Command | What it does |
| --- | --- |
| `forman start <name> --worktree <path> --contract <file>` | Send the contract text and real worktree path; accepts `--write`, `--model`, `--effort`, `--tier`, `--budget`, `--question-timeout`, `--skip-deps-check` |
| `forman status [<name>]` | Print one run's digest or the current group's digests |
| `forman events <name> [--after <n>] [--limit <n>]` | Print normalized events and the next sequence number |
| `forman steer <name> [<message>] [--file <path>]` | Send a change to the active turn |
| `forman followup <name> [<message>] [--file <path>] [--budget <dur>] [--effort <e>]` | Start another turn |
| `forman interrupt <name>` | Interrupt the active turn |
| `forman answer <name> <question-id> [<text>] [--file <path>]` | Answer a pending question |
| `forman result <name>` | Print the digest and available hand-off, naming its turn |
| `forman wait [<name>...] [--all] [--after <cursor>] [--timeout <dur>]` | Wait for attention, print summaries and digests, then a cursor for the next wait |
| `forman doctor` | Inspect local configuration, Codex and daemon availability |

Durations use nonnegative whole numbers with `ms`, `s`, `m` or `h`, such as `90s`, `45m` and `1h`. Wait defaults to 9 minutes and exits 0 for every outcome, including timeout and no active runs. Command failures retain the error table's exit codes.

Successful `command` log records use debug level; failed commands use error level. The configured minimum level still filters both.

| Script | What it does |
| --- | --- |
| `bun run dev <args>` | Run the CLI from source; logs go to `logs/`, data to `.dev/data` |
| `bun run lint` | Biome checks |
| `bun run format` | Biome formatting and safe fixes |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` / `bun run test:unit [file]` | Vitest on Node, optionally one file |
| `bun run coverage` | The unit suite with coverage |
| `bun run e2e` | Build, then test the compiled binary |
| `bun run build` | Compile `dist/forman` |
| `bun run check` | lint, typecheck, test and e2e |
| `bun run clean` | Remove build, test and log output |

## Configuration

Settings come from environment variables, then the optional file `$XDG_CONFIG_HOME/forman/config.json` (default `~/.config/forman/config.json`), then defaults. The CLI never reads `.env`; `.env.example` lists the variables.

| Variable | Config key | Default | Meaning |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `logLevel` | `warn` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `none` |
| `FORMAN_LOG_FORMAT` | | pretty | `json` writes stderr logs as JSON lines |
| `FORMAN_LOG_FILE` | | none | Also append JSON log records to this file |
| `FORMAN_DATA_DIR` | | `$XDG_DATA_HOME/forman` (`~/.local/share/forman`) | Where forman keeps its state |
| `CODEX_BIN` | | `codex` | Codex executable; resolved through `PATH` |
| `CODEX_HOME` | | `$HOME/.codex` | Codex configuration and state directory |
| `FORMAN_GREETING` | `greeting` | `Hello, world!` | Scaffold setting that `doctor` prints; goes away with the first real setting |

The config file is closed: an unknown key makes it invalid, which `doctor` reports.

## Architecture and tests

`src/bin.ts` supplies the Bun platform and hands argv to `src/main.ts`, which runs the Effect CLI command tree in `src/cli.ts`, turns errors into exit codes (2 usage, 3 invalid config, 6 permission denied, 130 interrupted, 1 internal) and prints results once. Commands in `src/commands/` call platform-free programs in `src/core/`; boundary shapes are Effect Schemas in `src/schemas/`; services in `src/services/`. Results go to stdout and logs to stderr, so `--json` output stays parseable.

Vitest runs on Node: `src/*.test.ts` for pure contracts, `tests/` for the CLI through the real parser, config and logging behaviour, and the Claude Code hooks. `e2e/` runs the compiled binary under Bun's test runner with a clean environment. The tree also carries the agent harness (Claude Code and Codex hooks, rules and skills) described in `docs/harness.md`.

## License

To be decided.
