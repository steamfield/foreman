# Changelog

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
