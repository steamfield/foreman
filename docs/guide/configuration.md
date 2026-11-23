# Configuration

foreman's optional config file, its environment variables and defaults, and where it keeps run state and logs under FOREMAN_HOME.

foreman needs no configuration to run. Settings come from the environment first, then `$FOREMAN_HOME/config.json`, then built-in defaults. The CLI never reads a `.env` file.

## Config file

`$FOREMAN_HOME/config.json` (default `~/.foreman/config.json`) is optional and accepts four keys:

```json
{
  "codexBin": "/opt/homebrew/bin/codex",
  "agyBin": "agy",
  "defaultModel": "gemini-4-neon",
  "logLevel": "info"
}
```

| Key | Meaning |
| --- | --- |
| `codexBin` | Codex executable: a name looked up on `PATH`, or a path |
| `agyBin` | agy executable, the same way |
| `defaultModel` | The model `start` uses when `--model` is omitted. It's routed like `--model`, so it can name a Codex or agy model |
| `logLevel` | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `none` |

An unknown key, a blank value or invalid JSON makes the file invalid. Commands that need config then fail with exit 3 and a message naming the problem; `foreman doctor` reports it and still exits 0.

## Environment variables

| Variable | Config key | Default |
| --- | --- | --- |
| `FOREMAN_HOME` | | `~/.foreman` |
| `CODEX_BIN` | `codexBin` | `codex`, resolved through `PATH` |
| `AGY_BIN` | `agyBin` | `agy`, resolved through `PATH` |
| | `defaultModel` | Unset: Codex's newest visible `gpt-*-sol` |
| `CODEX_HOME` | | `~/.codex`; foreman reads Codex's model catalog from here |
| `LOG_LEVEL` | `logLevel` | `warn` |
| `FOREMAN_LOG_FORMAT` | | Pretty stderr; `json` switches to JSON lines |
| `FOREMAN_LOG_FILE` | | No CLI log file; when set, the CLI also writes JSON records there and the daemon uses it instead of `logs/daemon.jsonl` |
| `CODEX_DELEGATE`, `AGY_DELEGATE` | | Unset. Any nonblank value marks the process as running inside a delegate, which makes `foreman monitor` print a snapshot instead of the live view |

Blank variables count as unset. Relative paths resolve from the directory you run the command in. foreman sets `CODEX_DELEGATE` or `AGY_DELEGATE` in the delegate's environment itself; you don't normally set them.

Start defaults that have no setting: `high` effort, the `priority` service tier on Codex, a 60-minute turn budget, a 15-minute question timeout (100 seconds on agy) and a 60-minute wait timeout. Override them per run with flags; see [Command reference](cli.md#start).

## FOREMAN_HOME

Everything foreman keeps lives under one directory, created with mode `0700`:

| Path | Contents |
| --- | --- |
| `config.json` | The optional config file |
| `foreman.sock` | The daemon's socket |
| `daemon.guard.sqlite`, `daemon.lock` | Daemon ownership: an advisory lock and the owner's PID. Don't delete them |
| `runs/<name>/` | One directory per run; see [How it works](how-it-works.md#storage) |
| `runs/.archive/` | Archived runs |
| `providers/agy/models.json` | agy's cached model catalog |
| `logs/` | Logs, below |

Put it on a local filesystem with working advisory locks, and keep the path short enough that the socket path fits in 104 bytes. Two homes mean two independent daemons: run names are global within a home, not across homes.

## Logs

| File | Written by |
| --- | --- |
| `logs/daemon.jsonl` | Daemon diagnostics (or `FOREMAN_LOG_FILE` when set) |
| `logs/app-server.log` | Codex app-server stderr |
| `logs/agy-stderr.log` | agy's stderr |
| `logs/agy-acp.log` | agy's own log |

foreman rotates the first three past 5 MB; agy manages its own. The CLI logs to stderr. Each command writes one record with the command, exit code, error tag and duration: at debug level on success and error level on failure, filtered by `LOG_LEVEL`. Raise the level with `LOG_LEVEL=debug` when diagnosing a problem.

Provider messages for a single run are in `runs/<name>/codex.jsonl` or `agy.jsonl`, redacted.

## Executables and versions

foreman's protocol checks are recorded against Codex 0.171.0 and agy 1.5.14. Another version still starts runs, with a warning on each new run. `foreman doctor` shows which executables it found, their versions and whether the protocol matches.
