# Changelog

## [0.3.0] - 2026-11-17

### Added

- `foreman monitor` can act on runs. It opens watching; the first action asks once per session before switching to acting, and `w` goes back to watching. While acting you can answer or defer a question, steer a running turn, send a follow-up, interrupt, archive and mark a run reviewed, with a confirm before interrupt and archive. Ctrl-e edits any text box in `$EDITOR`. While acting, the monitor keeps the running daemon alive; it still never starts or replaces one.
- Actions taken in the monitor are recorded with their source, so a run's events say "from foreman monitor". When the monitor and Claude Code answer the same question, the first answer wins; the monitor's later answer is refused and its draft kept.
- The run list shows task, model, progress and pace columns that drop out as the terminal narrows, pins failed, over-budget and quiet runs to the top, and shows a preview strip for the selected run.
- `/` filters the list, `:` opens a command palette, `g` changes grouping and `h` shows a history of finished and archived runs. A filter never hides a run that is waiting on you without saying so.
- Run detail shows changed files with line counts, a file's diff, the whole diff in `$PAGER`, a timeline, feed filters and search, and a review screen that combines the hand-off, files and diff.
- A first-run screen doubles as the legend for states and glyphs. The layout works at 80 columns, and `NO_COLOR` keeps bold and inverse video so state stays readable without color.
- `foreman monitor --line` prints a compact, passive one-line feed for tmux status bars and one-row panes; `--once` prints the first update and exits.

## [0.2.0] - 2026-11-16

### Added

- `foreman monitor` opens a live, read-only terminal view of every run across repositories, grouped by repo. Each run shows its state, budget, attention flags and what it is doing right now, with its Codex subagents listed underneath. Pending questions appear at the top with the command to answer them. Enter, or `foreman monitor <name>`, opens a run's detail: task, digest, questions, subagents, a live event feed, the last hand-off and copyable commands. The monitor never starts or keeps alive a daemon. Without a running daemon of this build it shows saved state from disk. Without a terminal, with `--json` or inside a Codex delegate it prints a snapshot instead.
- `foreman status --all` lists every run on the machine in one call, as text or JSON. It suggests next steps only for runs in the current repository; runs in other repos are labelled as supervised by their own session.
- `foreman events <name> --follow` prints a run's events as they happen and exits once the run is no longer active. It never starts a daemon; with none running it prints the saved events and stops.

### Changed

- Run event logs no longer store command output deltas, moderation metadata or diff updates, which made up most of a busy run's log.

### Fixed

- The daemon writes its ownership lock atomically, so another foreman process can no longer read a half-written lock file while a daemon starts.

## [0.1.3] - 2026-11-15

### Added

- `foreman update` installs the latest release with the package manager that installed foreman (npm, bun or pnpm global installs); `--check` only reports. Other installs are told how to update. A failed check or install exits 11 with the package manager's error and a next step.

### Changed

- A usage error leads with what was wrong, such as `Unknown command "updat". Did you mean "update"?`, then points to `--help`. The internal command log record no longer prints above it; it stays in the log file and in `--json` output.

## [0.1.2] - 2026-11-15

### Changed

- Releases publish from CI through npm trusted publishing with provenance, and `bun run release <version>` prepares the version bump. A failed publish now explains its cause and which packages already went out.

## [0.1.1] - 2026-11-15

### Added

- Codex threads are titled `<run> (<repo>)` before the first turn, so Codex and the ChatGPT app no longer name every run after the shared preamble.
- Status and digests name why an interrupted run stopped; a turn budget expiry shows as `budget expired`.

### Changed

- Wait text repeats its outcome above `cursor:` and `next:`, so tailed output and background task previews still show which question or completion woke it.
- Contract templates list only task-specific reading instead of having Codex re-read guidance it already loads.
- The supervise guide points to multi-name `foreman wait` instead of status polling loops.

## [0.1.0] - 2026-11-06

### Added

- `foreman guide [topic]` for the agent workflow and fillable contract templates, with command help covering accepted states, exit codes and examples.
- `foreman skill install` to install or print the bundled thin agent entry point without cloning the repository.
- The `foreman` command for delegating coding tasks to Codex in managed or prepared git worktrees, using the Codex CLI's ChatGPT login.
- A local daemon that keeps runs alive between CLI calls, with replacement of an idle outdated daemon on the next run command after an upgrade.
- Questions during a turn, with explicit or timeout deferral, late answers and corrections.
- Steering, follow-up turns and interruption, with waits and cursors scoped to the named run.
- Run digests, event history and turn hand-offs in text or JSON, including deferred decisions and changes outside the contract's scope.
- Turn budgets, with a read-only hand-off turn when time runs out.
- Repo hook trust checks before a run starts, and interruption of command execution when required project hooks didn't run.
- Archiving of run records, with guarded cleanup of managed worktrees and an option to keep unfinished work.
- Native npm packages for macOS and Linux on arm64 and x64, a `doctor` command and a Claude Code delegation skill.
