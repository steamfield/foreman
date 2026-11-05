# forman

forman lets Claude Code hand coding tasks to OpenAI's Codex and supervise them while they run. Claude starts a Codex agent in a git worktree, checks on it, steers or interrupts it, and answers questions Codex asks mid-turn. forman drives `codex app-server` and uses your existing Codex login (a ChatGPT plan); it never needs an OpenAI API key.

This is early. The repository currently holds the CLI skeleton (one `doctor` command); the bridge commands are being designed.

## Getting started

You need Node 26 or newer, Bun 1.4 or newer, git, and the Codex CLI signed in with `codex login`. lefthook is optional and installs the git hooks.

```sh
bun install
bun run build
./dist/forman doctor
```

`doctor` prints the version, platform, config file and data directory, and whether the config file is valid. It works even when the config is broken, and `--json` prints the same as one JSON object.

## Commands

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
| `FORMAN_GREETING` | `greeting` | `Hello, world!` | Scaffold setting that `doctor` prints; goes away with the first real setting |

The config file is closed: an unknown key makes it invalid, which `doctor` reports.

## Architecture and tests

`src/bin.ts` supplies the Bun platform and hands argv to `src/main.ts`, which runs the Effect CLI command tree in `src/cli.ts`, turns errors into exit codes (2 usage, 3 invalid config, 6 permission denied, 130 interrupted, 1 internal) and prints results once. Commands in `src/commands/` call platform-free programs in `src/core/`; boundary shapes are Effect Schemas in `src/schemas/`; services in `src/services/`. Results go to stdout and logs to stderr, so `--json` output stays parseable.

Vitest runs on Node: `src/*.test.ts` for pure contracts, `tests/` for the CLI through the real parser, config and logging behaviour, and the Claude Code hooks. `e2e/` runs the compiled binary under Bun's test runner with a clean environment. The tree also carries the agent harness (Claude Code and Codex hooks, rules and skills) described in `docs/harness.md`.

## License

To be decided.
