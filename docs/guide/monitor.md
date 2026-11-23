# Watching runs

foreman monitor shows every run on your machine live, grouped by repository, and can answer, steer or archive a run after you confirm.

The monitor is the human's view. Agents use `foreman status --all`, `foreman wait` and `foreman events` instead. It works the same for Codex and agy runs.

```sh
foreman monitor              # every run on this machine
foreman monitor fix-hooks    # one run's detail and live feed
```

## The list

Runs are grouped by repository and update as work happens. Each row shows the run's state, task, model, activity and budget as width allows. Pending questions and rows that need attention sit above the groups, and a preview of the selected run appears when the terminal has room.

| Glyph | State |
| --- | --- |
| `⣾` | running; the second line says what it is doing |
| `■` | waiting on a question (also used for interrupted) |
| `✓` | done: the turn finished, review it and archive |
| `×` | failed |
| `◐` | starting or unknown |
| `◌` | lost |

The budget bar shows time used of the turn's limit, not progress. A running turn with no open command and no activity for 5 minutes is flagged quiet: a prompt to look, not a failure. Press `?` for the full legend.

## Detail and review

Press Enter on a run, or start with `foreman monitor <name>`, to open its detail: contract, digest, questions, subagents, hand-off, changed files, timeline and the live event feed. For a finished run, `r` opens review, where `r` again marks it reviewed. Marking reviewed doesn't commit or archive anything, and the next turn clears it.

## Keys

| Where | Keys |
| --- | --- |
| List | `↑↓` or `j`/`k` select, Home/End and PgUp/PgDn jump, Enter opens a run or expands older idle runs, `/` filters, `!` toggles `needs:me`, `:` opens the palette (including copy command), `g` cycles grouping, `h` opens history |
| List and detail | `a` answer, `d` defer, `s` steer, `F` follow up, `i` interrupt, `x` archive. Each applies only when the run's state allows it |
| Answer or compose box | Enter or Ctrl-S sends, Ctrl-E opens `$EDITOR`, Esc cancels and keeps the draft, Ctrl-D defers a pending question |
| Interrupt and archive confirms | `y` confirms; in the archive confirm, `k` keeps the worktree |
| Detail | Tab changes pane, `j`/`k` scroll, `f` toggles feed follow, `1` to `5` filter the feed, `/` searches it |
| Files and review | `d` opens one file's diff (including untracked files), `n`/`p` move between hunks, `D` opens the tracked diff in `$PAGER`, `R` refreshes the file list |
| Anywhere | `?` help, Esc back, `q` quit (when no overlay or input is open), Ctrl-C quit |

## Watching and acting

The monitor opens watching. Its connection is passive: it doesn't keep the daemon alive, and it never starts or replaces a daemon.

The first action you take (answer, defer, steer, follow up, interrupt, archive or mark reviewed) asks you to switch to acting. Acting holds a connection that keeps the running daemon alive while the monitor is open. Press `w` to go back to watching; the next action asks again.

Acting needs a running daemon of the same build. Without one, the monitor shows saved state from disk, checks again every 10 seconds, and can't act. If the connection drops while acting, the monitor returns to watching and keeps your drafts; an action that was in flight may or may not have landed, so check with `foreman status <name>`.

Answers sent from the monitor only land on a question that is still open. If someone else answered first, the monitor keeps your draft instead of sending a correction. Interrupts and resolutions sent from the monitor are recorded as coming from the monitor.

## Line mode

For a tmux pane or status bar:

```sh
foreman monitor --line           # one-row live pane
foreman monitor --line --once    # print one update and exit, for status-right
```

Line mode shows the oldest pending question and run counts, or saved or reconnecting status. On a terminal it rewrites one truncated line; redirected, it prints each changed line without color. It is always passive, works inside a delegate, and can't take a run name or `--json`. `--once` requires `--line`.

## Snapshots

Without an interactive stdin and stdout, with `--json`, or inside a Codex or agy delegate (`CODEX_DELEGATE` or `AGY_DELEGATE` set), `foreman monitor` prints a snapshot instead: `status <name>` for a named run, otherwise `status --all`. That path uses the normal status command and may start the daemon.

`foreman events <name> --follow` is the plain-text alternative for one run: it streams events until the run becomes inactive and, like line mode, never starts or keeps a daemon alive.
