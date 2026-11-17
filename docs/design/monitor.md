# foreman monitor: TUI design

The visual contract for `foreman monitor`. It applies the site's console design ([`site/DESIGN.md`](../../site/DESIGN.md)) to a live terminal. The tokens below are copies of the site's `console-*`, `state-*` and `signal` tokens: `tests/monitor-theme.test.ts` reads `site/src/styles/global.css` and fails if they drift. A new value goes here and in that test first. Components use `src/tui/theme.ts`, never raw hex or named ANSI colors.

## Direction

The monitor is the site's supervision console, running for real: a dark console screen showing what each delegate is doing. It is designed for precision and density, and it assumes a reader who lives in a terminal. Every row should answer one of three questions: what is running, what is it doing, and what needs me.

## The one rule about orange

`signal` means a person is needed: a pending question, the `waiting` state, and the attention notes. Nothing else is orange. That includes focus, selection, the header, and the budget bar near its limit. The only exception is the front chevron of the mark, which follows the brand.

## Color

The full screen is painted with `console` so that contrast holds on any terminal theme.

| Token | Hex | Use |
| --- | --- | --- |
| `console` | `#121412` | Screen background |
| `console-2` | `#1B1E1A` | Header and footer bars, the selected row, chips |
| `console-line` | `#2D322B` | Rules, frame borders, the unfilled budget track, unfocused pane borders |
| `console-fg` | `#E4E8E0` | Text, run names, the focused pane's border and title |
| `console-muted` | `#9AA294` | Meta: ages, timestamps, paths, key-hint labels, secondary lines |
| `signal` | `#FF5B14` | Attention only (see above) |
| `state-running` | `#6FA8FF` | `starting`, `running`, working subagents, open commands |
| `state-done` | `#5CC98A` | `idle` after success, exit 0 |
| `state-failed` | `#FF7A70` | `failed`, non-zero exits, hooks blocked, the budget at or past its limit |
| `state-interrupted` | `#E2C04F` | `interrupted` and `unknown`, plus caution flags: quiet, retrying, files outside May change, the budget past 80% |
| `lost` | uses `console-muted` | `lost` |

Fallbacks:
- Color capability is taken from Ink's chalk detection.
- Truecolor uses the hex values above. 256-color uses chalk's nearest match.
- 16-color mode paints no background. States map to blue, green, red and yellow; `signal` maps to bright red with bold; muted maps to the default color with no emphasis.
- `NO_COLOR`, or no color support, gives no color and no background. Bold and inverse video are kept: selection becomes inverse, names and keys stay bold, and state glyphs carry meaning. Waiting and failed labels become `WAITING` and `FAILED`; question frames use heavy box drawing. Pinned failures read `FAILED` and budget warnings read `% OF BUDGET`.
- The renderer never uses dim (SGR 2), italics or blink. Muted text uses the muted color, because dim renders inconsistently across terminals.

## Type

Bold marks run names, group titles, pane titles, and the key in a key hint. Everything else uses regular weight. Numbers and durations are right-aligned in fixed-width columns so rows scan vertically: durations take a 5-character field (`12m`, `1h04m`), and budgets take `12/60m`.

## Glyphs

The vocabulary is the site's event feed and state badges, extended for motion.

| Meaning | Glyph | Color |
| --- | --- | --- |
| State square (badges, row lead) | `■` | state color |
| `waiting` square, pulsing | `■` / `□`, alternating every 800 ms | `signal` |
| Running (animated) | braille spinner `⣾⣽⣻⢿⡿⣟⣯⣷`, 100 ms per frame | `state-running` |
| Starting, or connecting to the daemon | `◐◓◑◒`, 150 ms per frame | `console-muted` |
| Open command | `…` | `state-running` |
| Command exit 0 | `✓` | `state-done` |
| Command exit N | `×N` | `state-failed` |
| Working subagent | `⠿` pulse: `⠿` / `⠶`, 400 ms | `state-running` |
| Idle subagent | `·` | `console-muted` |
| Tree | `├─` and `└─` | `console-line` |
| Mark | `›››`, two in `console-fg` and the front one in `signal` | as given |

The run-row lead glyph by state:

| State | Lead glyph |
| --- | --- |
| `running` | spinner |
| `starting` | `◐` spinner |
| `waiting` | pulsing `■` |
| `idle` | `✓` |
| `failed` | `×` |
| `interrupted` | `■` amber |
| `unknown` | `◐` amber |
| `lost` | `◌` muted |

When no daemon is running, the saved record can say `starting`, `running`, `waiting` or `unknown` for runs that nothing supervises. Those rows use a static muted `◌` and read `<state> · not supervised`. They lose the budget bar and the quiet flag, and their subagents stop animating. While an older daemon is still running, its runs keep animating, because it may still be supervising them, and the header says the data is saved state.

## Motion

Motion shows that work is happening, nothing else. One shared 100 ms tick drives every animation, and it runs only while something on screen animates; an all-idle screen does not re-render. Spinners use one color, with no color cycling. Rows whose data did not change re-render only their glyph cell: memoise row components on the run's view-model identity, and take the moving parts from the tick. This mirrors rr's card cache, so a frame with ten runs stays cheap.

Ages and elapsed times recompute on the tick at one-second resolution, from timestamps. The daemon is never polled for clocks.

## Components

### Header and footer

The header is one line on `console-2`: the mark, bold `foreman`, muted version and the mode chip. Watching reads `◇ watching` in muted; acting reads `◆ acting` in running blue. Acting adds `daemon stays up while this monitor is open · w to watch only` when it fits. The right side holds that note, daemon status, default model settings and state counts. As width shrinks, the acting note drops first, then daemon status and defaults, keeping counts longest. With no daemon, the order favors keeping the daemon warning.

The footer uses the same background, with bold keys and muted labels on the left and freshness or reconnection status on the right when it fits. Hints follow the current screen or overlay. The ordinary list and detail footer collapses to `? help  q quit` below 24 rows. At narrow widths the list favors open, answer, filter, palette and help.

### Questions and pinned rows

Question notes precede the groups, at most three (one below 24 rows), followed by `+N more`. A frame names the run, question id, waiting age and deferral countdown. Its question text is one truncated line. At 100 columns and above a separate line shows `foreman answer fix-hooks q2 --file <path>`; below 100 the frame becomes three lines and offers `a answer` on its bottom border. Other repos retain `other repo: its own session supervises it`. Notes remain visible when their runs are hidden by a filter.

Non-question attention follows the question notes: failed runs first, then active runs at or above 80% of budget, then quiet running runs without an open command. Within each reason, older cases come first. There are at most three pinned rows and a `+N more` count. A run can have more than one reason. Failed rows use `×` and red; budget and quiet rows use `▲` and amber. At 100 columns and above each row includes its reason and key hints; below 100 the three cases share one compact line. These rows also remain visible through filtering. Saved state with no daemon suppresses budget and quiet pins.

### Groups and run rows

`g` cycles repo, state and recent grouping. Repo grouping puts the cwd's main checkout first, then repos by recent activity. State grouping orders waiting, running, starting, failed, interrupted, unknown, lost and idle. Recent grouping is one flat group ordered by state-change time. Group rules use `console-line`, bold fg titles and muted state counts; while filtering, summaries report shown and hidden counts. Idle runs older than 24 hours collapse to a muted count per group; Enter expands them.

Each run has two lines, plus subagent lines at 100 columns and above. Line 1 has the lead glyph, bold name, model and effort, state and age, task, pace, progress, budget and flags as width allows. The task is the stored title taken from the contract's first heading, falling back to its first nonblank line. Model names are shortened and medium effort reads `med`. Progress reads `t2 · 14 cmds` with a red failure count. Pace is events per minute over the last 12 minutes, an activity signal rather than completion progress.

Line 2 is indented four columns. It shows the open command and age first, otherwise commentary in quotes, otherwise the outcome as `done:` or `failed:` and its first prose line. Subagents use tree lines, a working or idle glyph, path and activity age; model and effort appear when they differ from the parent's. Below 100 columns the activity line carries a subagent count instead. Selection fills every line of the run with `console-2`, with no colored stripe.

Flags after the budget show pending questions in `signal`, deferred questions, quiet, retries and outside-scope writes in amber, hook blocks in red, and non-default settings in muted. Below 100 columns only the most urgent flag is kept, with compact wording; when no urgent flag applies it can show budget percent or `review`/`reviewed`.

The budget bar uses `━` for elapsed cells and `─` in `console-line` for remaining cells. Elapsed cells are blue below 80%, amber from 80% and red at 100%. It has 10 cells at 120 columns and above, 6 at 80–119, and none below 80. The `12/60m` label appears at 140 columns and above. Inactive or unsupervised runs have no bar. It measures time spent against the turn's limit, never work completed.

### Preview strip

At 30 rows and above, the selected list run gets a five-line frame above the footer. It shows contract prose (falling back to the task title), current activity, the latest retained commentary, and up to three recorded file paths with a remaining count. Outside-scope paths use `▲` and an outside count. These paths come from the detail digest, without line counts or a worktree refresh. The strip disappears in detail, history and help, and when no run is selected.

### Filter, palette and history

`/` in the list or history opens a filter bar under the header. Matching is case-insensitive and every whitespace-separated token must match. Enter keeps the filter; Esc clears it. The bar shows matching and total counts. The list also warns when waiting runs are hidden, while keeping their attention notes visible.

| Token | Match |
| --- | --- |
| `state:running,waiting` | Any named state in the comma-separated list |
| `repo:text` | Repository path containing text |
| `model:text` | Model or effort containing text |
| `needs:me` | Pending questions or a failed, budget or quiet pin in the list |
| Plain text | Run name, task title or activity; history also searches repo |

`!` adds or removes `needs:me` without discarding other tokens. `:` in the list opens a centered command palette for the selected run. Typing filters labels; arrows choose, Enter executes and Esc closes. It lists eligible answer, defer, steer, follow-up, interrupt and archive actions, copyable CLI commands, and grouping, history, filter and help. While watching, a heading explains that actions switch to acting. Copy uses the terminal's OSC 52 clipboard support and reports a notice.

`h` opens history, a table of finished and archived runs with repo, task, outcome, end age, duration, turns and tokens. It reads at most 500 run journals and reports unreadable entries. The list filter carries into history. Arrows or `j`/`k` select; Home/End jump; `h` or Esc returns. History is a browsing table, with no Enter-to-open or mutation shortcuts.

## Watching and acting

The interactive monitor opens watching. The first eligible action opens `Switch to acting?`, explaining that acting holds the daemon open. `y` or Enter confirms; `n` or Esc cancels. The confirmed action then opens its input or confirm, or sends the immediate action. `w` returns to watching, and the next action asks again. Acting needs a live daemon of this build; saved or reconnecting feeds show a notice instead. The live monitor never starts or replaces a daemon.

| Action | Key and target |
| --- | --- |
| Answer | `a` targets the selected run's first pending question, falling back to a question in the unfiltered list. Review can target a deferred question for a late answer. |
| Defer | `d` sends immediately while acting for a pending question; in the Files pane it opens a diff instead. A deferred question cannot be deferred again. |
| Steer | `s` opens compose for a starting or running turn. |
| Follow up | `F` opens compose for idle, failed or interrupted runs. |
| Interrupt | `i` opens a confirm for starting, running or waiting runs. |
| Archive | `x` opens a confirm for idle, failed, interrupted or lost runs. The daemon treats `unknown` as active, so those runs are not offered archive until `foreman status` resolves them. |
| Mark reviewed | `r` in review marks an idle, failed or interrupted run reviewed. |

Overlays are centered over the list or detail, at most 104 columns wide with a four-column outer margin. They use fg borders and titles, console fill, and their own footer hints. While open they own input, so typing `q` or `j` in a draft does not quit or move selection.

The answer box names the run and question, kind, asked time, waiting age and deferral countdown. It wraps the question and clips it with `…` when height is limited. When detail events are loaded and there is room, `Leading up to it` shows up to three preceding feed lines. The draft occupies a three-line input area. Enter or Ctrl-S sends nonblank text; Ctrl-D defers a pending question; Ctrl-E opens `$EDITOR`; Esc closes and keeps the draft. The delegating agent may answer too: the first accepted answer wins. If the question resolves while typing or the daemon rejects the answer, the draft is kept.

Compose for steer and follow-up shows run, turn, state and age above the same draft input. Enter or Ctrl-S sends; Ctrl-E opens `$EDITOR`; Esc keeps the draft and closes. Editor hand-off suspends the TUI and restores it on return. Successful sends remove the corresponding draft; failures keep it.

The interrupt confirm shows turn and budget facts, the open command when present, command count when detail is loaded, and outside-scope writes. `y` interrupts, `s` switches to steer when eligible, and `n` or Esc cancels. The archive confirm names the worktree and branch and warns about deletion and uncommitted changes. `y` requests normal archive cleanup, `k` archives while keeping the worktree, and `n` or Esc cancels. The daemon still enforces safe managed cleanup and retains prepared worktrees; the confirm does not override those checks. Enter confirms acting only; interrupt and archive require their displayed letter.

Notices occupy one line above the footer: `✓` with done color for success, `×` with failed color for errors. They name the result or rejection and clear on the next key. A lost acting connection returns to watching and retains drafts. If a mutation was in flight, its outcome can be unknown and the notice points to `foreman status <name>`.

## Detail, diff and review

Enter on a list run or `foreman monitor <name>` opens detail. Its framed header shows state and name plus worktree, branch, base, model, turn and connection facts. Labels are muted and values fg. The panes are Task, Digest, Questions, Subagents, Hand-off, Commands, Files and Feed, cycled with Tab. Focused borders and titles use fg; other borders use `console-line`. Arrows or `j`/`k` scroll the focused pane; Home/End and PgUp/PgDn move through it. Esc returns to the list.

Feed entries use muted timestamps; commands use `…`, `✓` and `×N`; file writes read `write <path>`; messages use fg; questions and hook blocks are framed notes. State, turn and resolution lines use muted. Monitor resolutions and interruptions say `from monitor`. `f` toggles follow; scrolling upward in the feed pauses it. The title reads `following` or `paused · f to follow`. Keys `1`–`5` select all, commands, files, messages or questions (including hook blocks). `/` searches displayed feed lines case-insensitively; Enter retains the search and Esc clears it. The feed buffers 1,000 events and shows dropped-event and gap notices.

Files lists changed paths against the recorded base commit, including untracked files, with status, added/removed counts and `▲` for paths outside May change. Unavailable untracked counts read `?`; other unavailable counts read `binary`. Reads happen on opening detail or review and on `R`, rather than continuously. `j`/`k` selects a file and `d` opens its unified diff, including an untracked file's contents. `D` from detail, diff or review opens the combined tracked Git diff in `$PAGER` (default `less -R`); it excludes untracked files, which must be opened individually with `d`. Diff lines retain `+`/`-`, old/new line numbers and hunk headers; additions are green, removals red and hunk headers blue. `n`/`p` jumps hunks, `[`/`]` changes files, arrows or `j`/`k` scroll, and PgUp/PgDn/Home/End navigate. Esc closes the diff. Inline diffs stop at 512 KiB with a notice; pager reads refuse diffs over 16 MiB.

A timeline frame above detail compresses the run's lifetime into working `━`, failed-command `×`, quiet `┄` and question `■` cells, with time ticks and a legend. When subagents exist it adds their activity track. It uses retained events, appears at widths of at least 40 columns when height permits, and is absent in review.

`r` from the list or detail opens review for an idle, failed or interrupted run. The summary shows turns, elapsed/budget time, commands, changed files, outside-scope count and review status. Hand-off and `Decided without you` frames sit above Files and Diff; below 120 columns Files and Diff stack. Deferred decisions show the question and the first subsequent agent message when available. Tab cycles hand-off, decisions, files and diff. `a` can answer an unresolved deferred question late; `r` marks reviewed through the daemon, `F` follows up and `x` archives. Marking reviewed does not commit or archive; a new turn clears the mark.

## First run, help and connection states

With no current runs and a compatible or absent daemon, the first-run screen explains that the coding agent starts runs, gives an example delegation request, and names `foreman doctor` and `foreman skill install`. It teaches running, waiting, done and failed, plus the budget bar's meaning. With no daemon it shows the next probe countdown and updates itself. An outdated daemon keeps its saved-state explanation instead. The screen does not offer a start-run action.

`?` opens a centered keyboard reference and the same state legend, plus starting, unknown, interrupted, lost and subagent glyphs. It ends with `foreman status --all for scripts and agents`. `?` or Esc closes it. `q` quits when no action overlay or text input is open; Ctrl-C interrupts and restores the terminal.

Saved, outdated, reconnecting and archived-detail states say what is available and give a command where needed. No daemon means saved active rows are explicitly unsupervised. An outdated daemon's rows can still animate, but acting is unavailable. Reconnecting retains the last data with subdued tones. Watching and acting both preserve the feed's passive reconnection behavior; acting has its own connection-loss notice.

## Layout breakpoints

| Width | Layout |
| --- | --- |
| ≥ 140 | All optional columns, including the numeric budget label; 10-cell bar and side-by-side detail/feed |
| 120–139 | Budget label drops; pace remains; 10-cell bar and side-by-side detail/feed |
| 100–119 | Pace drops; progress remains; 6-cell bar; detail panes stack |
| 90–99 | Progress drops; model and task remain; subagents become a count and flags compact |
| 80–89 | Model drops; task remains with name, state, age and 6-cell budget bar; compact question notes and pins |
| < 80 | Task and budget bar drop; name, state, age, activity and a compact flag remain |

| Height | Layout |
| --- | --- |
| < 24 | Footer collapsed, attention notes limited to one |
| 24–29 | Standard footer; no preview strip |
| ≥ 30 | Five-line selected-run preview in the list |
| ≥ 40 | Detail panes have more room for feed entries and the timeline |

At 80 columns the list remains two lines per run, with Task still visible. Notes take three lines, pins share one line, subagents become a count and the footer keeps its shorter hints. Optional columns drop in this order: budget label, pace, progress, model, task. Truncation uses `…`, and rows never wrap. Terminal string width determines clipping, including wide characters. Overlay paragraphs and input can wrap within their frames.

## Line mode and snapshots

`foreman monitor --line` prints a compact passive overview without input, overlays or an alternate screen. With a pending question it shows the oldest run/question and age, plus a count of further questions; it also counts working, done, failed and interrupted runs. With no pending question it says `nothing needs you`. Saved state identifies no daemon or an outdated daemon and counts saved runs; reconnecting is explicit.

On a TTY it rewrites one line, clipped to terminal width minus one, until interrupted. With redirected output it prints changed lines without color. `--line --once` prints the first update and exits for a status bar, even when that update is saved state. Line mode works inside a Codex delegate and never starts, replaces or keeps a daemon alive. It rejects a run name or `--json`; `--once` requires `--line`.

Ordinary `monitor` without both TTYs, with `--json`, or under `CODEX_DELEGATE` prints the normal named status or all-runs snapshot. That path may start the daemon; text output includes a note explaining the fallback. Scripts and agents use `status --all`, `wait` and `events`.

## Verification

- `tests/monitor-theme.test.ts` checks that every token in `src/tui/theme.ts` equals the matching value in `site/src/styles/global.css`, and that the contrast of `console-muted` and each state color on `console` and `console-2` is 4.5:1 or better.
- Render and model tests under `tests/monitor-*.test.ts` cover list, detail, acting overlays, finding, inspection, review, first-run and narrow layouts. Snapshots pin list, detail and review frames.
- `tests/monitor-render.bench.ts` measures rendering separately from the unit gate.
- `tests/monitor-fallbacks.test.ts` checks 80-column and `NO_COLOR` treatment, including retained bold and inverse selection. `tests/monitor-command.test.ts` and `tests/monitor-line.test.ts` cover line mode and snapshot fallbacks.
