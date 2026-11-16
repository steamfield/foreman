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
- `NO_COLOR`, or no color support, gives no color and no background. Selection becomes inverse video, and the state glyphs and bold weight carry all meaning.
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

## Motion

Motion shows that work is happening, nothing else. One shared 100 ms tick drives every animation, and it runs only while something on screen animates; an all-idle screen does not re-render. Spinners use one color, with no color cycling. Rows whose data did not change re-render only their glyph cell: memoise row components on the run's view-model identity, and take the moving parts from the tick. This mirrors rr's card cache, so a frame with ten runs stays cheap.

Ages and elapsed times recompute on the tick at one-second resolution, from timestamps. The daemon is never polled for clocks.

## Components

Header bar: one line on `console-2`.
- Left side: the mark, then `foreman` in bold, then the version in muted.
- Right side, in this order: daemon status, which is either `daemon up 2h14m` (muted) or `daemon not running · saved state` (amber); a default-settings chip such as `gpt-6.1-sol · high · fast` (muted); and state count badges such as `■ 2 running` and `■ 1 waiting`, each with its square in the state color and its count in fg.
- Drop elements from the right as width shrinks. The counts go last.

Attention notes: these appear only when some run in the list needs a person. The note sits between the header and the groups, at most three of them, and a fourth case shows `+N more`.
- Each note is a frame drawn in `console-line` and headed by a waiting badge, for example `╭─ ■ waiting  fix-hooks q2 · 3m · defers in 12m ─╮`.
- The body is one line of question text truncated with `…`, then the copyable command `foreman answer fix-hooks q2 --file <path>` in fg.
- Notes for other repos show `other repo: its own session supervises it` in place of the command.

Group header: a section rule in the rr style, with square corners.
- Layout: `── claude-codex ───────────────────── 2 running · 1 waiting ──`.
- The rule is `console-line`, the title is fg bold, and the summary is muted.
- The cwd's group comes first, then groups ordered by most recent activity.

Run row: two lines, then one line per subagent.
- Line 1: the lead glyph; the name in bold; the state word in the state color with its age in muted; `t2 followup` in muted; the budget bar; and flags.
- Line 2 is indented four columns and shows the activity. It comes from the first source that applies:
  - an open command, shown as `…` plus the command text in fg and its age in muted
  - the latest commentary, in muted, inside `“…”`
  - the outcome, as `done:` or `failed:` plus its first line
- Selection paints the full width of all of the run's lines with `console-2`. There is no colored left stripe, following the site's rule for active items.

Flags appear after the budget bar, separated by `·`:
- `q2 pending 3m` in `signal`
- `2 deferred` in amber
- `quiet 6m` in amber
- `retrying (usage limit)` in amber
- `3 hooks blocked` in red
- `2 outside scope` in amber
- settings that differ from the defaults (`effort medium`, `read-only`) in muted

Budget bar: 10 cells.
- Elapsed cells are `━`. They are running blue below 80% of the budget, amber from 80%, and red at 100% or past it, which is the hand-off case.
- Remaining cells are `─` in `console-line`.
- `12/60m` follows in muted.
- Inactive runs show no bar.

Subagent line: `├─`, then the glyph, then the path (`/root/acceptance_tests`) in fg, then `working · 20s ago` or `idle · 2m ago` in muted. Model and effort appear only when they differ from the parent's.

Older idle runs: one muted line per group, `· 7 idle runs older than 24h`. Enter on it expands them.

Footer bar: one line on `console-2`.
- Left side: key hints, each with the key in bold fg and the action in muted, two spaces apart.
- Right side: `updated 0.4s ago` in muted. When the connection is lost it shows `reconnecting in 4s` in amber instead.
- Below 24 rows, the footer shrinks to `? help  q quit`.

Detail view:
- Header block: a frame headed by the run's state badge and its name. Inside it, two columns of label and value pairs. Labels are muted and right-aligned; values are fg.
- Panes are frames with `╭─ Title ─────── value ─╮` headers in rr's section-header style. The focused pane's border and title are fg, and unfocused panes use `console-line`.
- The panes are task, digest, questions, subagents, hand-off, commands and the feed.
- Feed entries follow the site's EventFeed:
  - a muted timestamp
  - commands with `…`, `✓` or `×N`
  - file writes as `write <path>`
  - messages as plain fg text
  - questions and hooks blocked as small framed notes headed by their badges
  - state, turn and resolution lines in muted
- When follow is on, the feed header shows `following` in muted. When it is off it shows `paused · f to follow`.

Help overlay: a centered frame drawn over a `console` fill. It holds the key table in two columns, the glyph legend, and a single line pointing to `foreman status --all` for scripts and agents.

Empty, no-daemon, outdated and lost states: a centered block. One fg line says what is happening, one muted line says what to do, and the command to run is shown in fg. The `◐` spinner appears only while probing.

## Layout breakpoints

| Width | Layout |
| --- | --- |
| ≥ 120 | Full row and side-by-side detail panes |
| 80–119 | The budget bar shrinks to 6 cells, the turn kind drops, and detail panes stack |
| < 80 | Lead glyph, name, state and age on line 1; activity on line 2; flags reduced to the most urgent one; no tree lines for subagents (count only) |

| Height | Layout |
| --- | --- |
| < 24 | Footer collapsed, attention notes limited to one |
| ≥ 40 | Detail panes get their full height, and the feed shows 30+ entries |

Truncation always uses `…` at the end of a field, and never wraps a row. Wide characters are measured with Ink's string width.

## Verification

- `tests/monitor-theme.test.ts` checks that every token in `src/tui/theme.ts` equals the matching value in `site/src/styles/global.css`, and that the contrast of `console-muted` and each state color on `console` and `console-2` is 4.5:1 or better.
- Golden render tests with `ink-testing-library` cover the list, detail, help and each state at 70, 100 and 140 columns. Each test keeps two snapshots: frames with ANSI stripped (the layout), and frames with escapes kept for one fixture per state (the colors).
- A render benchmark test renders a 10-run frame 100 times and asserts it stays under a stated time budget.
- `NO_COLOR=1` render tests show that state stays readable from glyphs alone.
