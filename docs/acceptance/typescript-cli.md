# Configuration and logging acceptance

The shipped `tests/config-logging.test.ts` implements this matrix; the manifest runs it independently of
hook tests. Use the real parser, AppLayer, configuration reader and logger through
`runCli`, with files under temporary HOME/FORMAN_HOME directories. Do not mock config or
assert only the decoded setting: assert records actually emitted and suppressed.

| Input | Required observation |
| --- | --- |
| No file or environment setting | Default warn level; doctor succeeds with no command record on stderr |
| config.json logLevel debug | A debug diagnostic and the successful command record reach the captured sink |
| config.json logLevel info | The debug diagnostic and successful command record are absent |
| File debug, LOG_LEVEL none | Environment wins; all logs are absent |
| File info, blank LOG_LEVEL | Blank is absent; the file's setting applies |
| Failed command at default level | Command record is emitted at error, with the existing error envelope |
| Invalid file level | Doctor still reports the config problem and uses the safe fallback |
| Two invocations with different files/levels | No level, config or buffered-log state leaks |
| CODEX_BIN / file codexBin set, absent or blank env | Environment wins over file, file over default `codex`; doctor reports the resolved executable |
| FORMAN_HOME set, relative, absent or blank | Explicit env selects the home; relative paths resolve at the caller's cwd; absent or blank uses `$HOME/.forman`; config.json and all state use that home; legacy XDG and FORMAN_DATA_DIR settings are ignored |
| CODEX_HOME set, absent or blank | Explicit env wins over `$HOME/.codex`; blank is absent, independent of FORMAN_HOME |

Exercise file/env/default precedence for `codexBin` through `doctor --json` too. If a command exposes an explicit setting flag, assert its
precedence over env and file; do not add a logging flag just for these tests.

Assert status and both streams for human and JSON doctor, including invalid
configuration. Decode JSONL log records and check levels, UTC time, command,
duration and outcome; assert no secret values. The compiled binary suite repeats
file-only logging and `codexBin` file/env/default precedence using a clean environment. A test that
only sees logLevel in a decoded object does not satisfy this contract.
