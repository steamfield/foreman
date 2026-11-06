# Changelog

## [0.1.0] - 2026-11-06

### Added

- The `foreman` command for delegating coding tasks to Codex in managed or prepared git worktrees, using the Codex CLI's ChatGPT login.
- A local daemon that keeps runs alive between CLI calls, with replacement of an idle outdated daemon on the next run command after an upgrade.
- Questions during a turn, with explicit or timeout deferral, late answers and corrections.
- Steering, follow-up turns and interruption, with waits and cursors scoped to the named run.
- Run digests, event history and turn hand-offs in text or JSON, including deferred decisions and changes outside the contract's scope.
- Turn budgets, with a read-only hand-off turn when time runs out.
- Repo hook trust checks before a run starts, and interruption of command execution when required project hooks didn't run.
- Archiving of run records, with guarded cleanup of managed worktrees and an option to keep unfinished work.
- Native npm packages for macOS and Linux on arm64 and x64, a `doctor` command and a Claude Code delegation skill.
