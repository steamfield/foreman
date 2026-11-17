# foreman monitor v1

> **Status:** DRAFT
> **Author:** Claude (for Riley Hilliard)
> **Date:** 2026-11-16
> **Audience:** product owner and design. No code reading required.
> **Baseline:** `foreman monitor` as shipped in foreman 0.2.0 (commits `f809604` through `26e741e`).

## TL;DR

`foreman monitor` is a live, read-only terminal screen that shows every Codex run foreman is supervising on a machine: what state each is in, what it is doing this second, and which ones are blocked on a person. In 0.2.0 it is a well-built MVP: two screens (a list and a run detail), eight keys, one dark theme, and no way to act on anything it shows. v1 should make it the place a developer runs their delegated work from, not only the place they watch it, and section 15 sketches the dashboard that gets there. This document describes the shipped product in enough detail to draw mocks against, then lists what the product and design teams need to decide to get to v1.

## How to read this document

Section 15 describes the ideal dashboard the v1 should be heading toward. Sections 1 to 5 describe what exists today. They are facts taken from the code, the design contract (`docs/design/monitor.md`) and the render snapshots, and each screen description matches what the terminal draws. Section 6 onward is proposal and is marked as such. Where a statement is a guess, it says so.

---

## 1. What foreman is, and where the monitor fits

foreman is a command-line tool that lets an AI coding agent (usually Claude Code) hand a coding task to OpenAI's Codex. The work happens in its own git worktree, so it never touches the developer's checkout. A background process called the daemon keeps the Codex session alive between commands. The delegating agent writes a "contract" (the task, which files may change, which must not), starts a run, answers questions Codex asks, sends corrections, and reviews the result before committing.

Vocabulary the mocks will need:

| Term | Meaning |
|---|---|
| Run | One delegated task, with a unique short name such as `fix-hooks`. Lives in one git worktree on one branch. |
| Turn | One round of work inside a run. Turn 1 is the start; later turns are follow-ups or an automatic hand-off turn. |
| Contract | The written task: goal, "May change" files, "Must not change" files. |
| Question | Codex pausing to ask something. Pending until answered, then resolved. If nobody answers within a timeout it is deferred and Codex continues on its best guess. A late answer is still possible. |
| Blocked | A second kind of question: Codex cannot proceed because something is denied. |
| Hand-off | The summary Codex writes when a turn ends. |
| Budget | A time limit per turn (for example 60 minutes). At the limit the run moves to a read-only hand-off turn. |
| Subagent | A child agent Codex spawns inside a run, shown by path such as `/root/acceptance_tests`. |
| Repo group | Runs are grouped by the main checkout of their repository. |
| Daemon | The local supervisor. The monitor can run with or without it. |

The people involved are two: the delegating agent (Claude Code) which drives foreman through ordinary commands and `--json`, and the developer who owns the machine and wants to see what is going on. The monitor is for the developer. Agents are not meant to use it; they use `foreman status --all`, `wait` and `events`.

## 2. The problem the monitor solves

A developer who has an agent delegating to several Codex runs in parallel, possibly across several repos, has no view of the whole. Each run's state is only visible by asking the delegating agent, or by running `foreman status` per run. The monitor answers three questions in one screen: what is running, what is it doing, and what needs me.

Evidence: the monitor was built because of this gap and the maintainer calls the result "fantastic". There is no usage data, no telemetry in the tool, and no outside users to cite yet. Treat all demand claims below as hypotheses (see section 11).

## 3. The product as shipped

### 3.1 Entry points

| Command | Result |
|---|---|
| `foreman monitor` | Live list of every run on the machine, grouped by repo. The repo you are standing in is listed first. |
| `foreman monitor <name>` | Opens straight into that run's detail screen. |
| `foreman monitor --json`, output piped or redirected, or run inside a Codex delegate | Not interactive. Prints the text or JSON snapshot that `foreman status --all` (or `status <name>`) prints. A one-line note explains why. This path may start the daemon. |

The live view is read-only and never starts, replaces or keeps alive a daemon. Quitting is `q`. Ctrl-C exits with code 130.

### 3.2 Three connection modes

The screen works with or without a daemon, and the design has to show which mode it is in.

| Mode | When | What the user sees |
|---|---|---|
| Live | A daemon of this build is running | Everything animates. Footer says `updated 0.4s ago`. Header says `daemon up 2h14m`. |
| Saved state | No daemon, or a daemon from an older build | Data is read from disk. Header says `daemon not running · saved state` in amber. Runs the daemon would have supervised show as `<state> · not supervised`, with a static muted `◌`, no budget bar and no animation. The monitor re-probes every 10 seconds and switches to live on its own. |
| Reconnecting | The daemon connection dropped | Footer says `reconnecting in 4s` in amber. The last data stays on screen. |

### 3.3 Screen 1: the run list

Layout, top to bottom: header bar, attention notes (only if some run needs a person), repo groups with their runs, footer bar. The list scrolls and keeps the selected run in view.

Header bar (one line): the mark `›››` (two chevrons in off-white, the front one orange), `foreman`, the version. On the right, in this order and dropped from the right as width shrinks: daemon status, a chip with the default model settings such as `gpt-6.1-sol · high · fast`, and one count badge per state such as `■ 2 running  ■ 1 waiting`.

Attention notes: a framed box per pending question, at most three, then `+N more`. Each says which run, which question id, how long it has waited and when it will be deferred, shows the question text on one line truncated with `…`, and shows the exact command to answer it (`foreman answer fix-hooks q2 --file <path>`). For a run in another repo the command is replaced by `other repo: its own session supervises it`.

```
╭─ ■ waiting  fix-hooks q2 · 3m · defers in 12m ───────────────────╮
│ Keep the existing hook API, or can I change the signature?        │
│ foreman answer fix-hooks q2 --file <path>                         │
╰───────────────────────────────────────────────────────────────────╯
```

Repo group header: a rule with the repo name left and a state summary right. `── claude-codex ───────────── 2 running · 1 waiting ──`.

Run row, two lines plus one per subagent:

```
 ⣾ fix-hooks            running   12m   t2 followup   ━━━━──────  12/60m   q2 pending 3m · quiet 6m
    … bun run check · 20s
    ├─ ⠿ /root/acceptance_tests   working · 20s ago
    └─ · /root/review             idle · 2m ago
```

Line 1 is lead glyph, bold name, state word in its colour with its age, turn number and kind, a 10-cell budget bar with `elapsed/limit`, then flags. Line 2 is the current activity, picked from the first that applies: an open command with its age, the latest Codex commentary in quotes, or the outcome (`done:` or `failed:` with its first line). Subagent lines show path, working or idle, and age; model and effort appear only if they differ from the parent.

Older idle runs collapse to one muted line per group: `· 7 idle runs older than 24h`. Enter expands it.

Footer bar: key hints on the left, freshness on the right. Under 24 rows it shrinks to `? help  q quit`.

### 3.4 Run states and what they look like

| State | Meaning | Lead glyph | Colour |
|---|---|---|---|
| starting | Preflight and thread setup | `◐` spinner | muted |
| running | A turn is executing | braille spinner | blue |
| waiting | A question needs a person | pulsing `■` / `□` | orange (the only orange state) |
| idle | Turn finished OK | `✓` | green |
| failed | Turn failed | `×` | red |
| interrupted | Stopped on request or by budget | `■` | amber |
| unknown | State could not be determined | `◐` | amber |
| lost | The daemon restarted and lost live state | `◌` | muted |

Flags that can follow the budget bar: `q2 pending 3m` (orange), `2 deferred` (amber), `quiet 6m` (amber, a running run with no output for five minutes or more), `retrying (usage limit)` (amber), `3 hooks blocked` (red), `2 outside scope` (amber, files changed outside "May change"), and any setting that differs from the defaults (`effort medium`, `read-only`) in muted. The budget bar turns amber at 80% of the limit and red at 100%.

### 3.5 Screen 2: run detail

Opened with Enter on a row or `foreman monitor <name>`. On wide terminals it is two columns: a stack of seven panes on the left and the live feed on the right. Below 120 columns the panes stack.

```
››› foreman 0.2.0                     daemon up 2h14m  gpt-6.1-sol · high · fast  ■ 1 waiting
╭─ ■ waiting  fix-hooks ─────────────────────╮╭─ Feed ─────────────────── following ─╮
│ worktree /repo/work   branch work          ││ 12:00:00 … bun run check             │
│ base abc123           --from main          ││ 12:00:00 ✓ bun run lint              │
│ created 11:00:00 · 1h00m ago               ││ 12:00:00 ×2 bun run test             │
│ model gpt-6.1-sol · high · fast            ││ 12:00:00 write src/hooks.ts          │
│ turn 2 followup       connection live      ││ ╭─ 12:00:00 ■ question q1 ─────────╮ │
╰────────────────────────────────────────────╯│ │ Keep the API?                    │ │
╭─ Task ─────────────────────────────────────╮│ ╰──────────────────────────────────╯ │
│ # Fix hook handling                        ││ ╭─ 12:00:00 ■ hooks blocked ───────╮ │
│ May change: src/hooks.ts                   ││ │ pre-commit: Fix lint first.      │ │
│ Must not change: src/daemon/               ││ ╰──────────────────────────────────╯ │
╰────────────────────────────────────────────╯│ 12:00:00 running → waiting           │
╭─ Digest ───────────────────────────────────╮│ 12:00:00 turn 2 followup             │
│ commands  12 total · 1 failed · 2 blocked  ││                                      │
│ files  1 written · 0 outside May change    ││                                      │
│ tokens  1K input · 750 cached (75% hit)    ││                                      │
╰────────────────────────────────────────────╯╰──────────────────────────────────────╯
Tab pane  jk scroll  f follow  Esc list  ? help  q quit                  updated 0.0s ago
```

The seven panes, in order:

| Pane | Content |
|---|---|
| Header block | State badge and name; worktree, branch, base commit, `--from` ref, created and updated times, run directory, model, turn, connection mode. |
| Task | The contract text. If long, the title shows `truncated at N bytes`. |
| Digest | Command counts (total, failed, hooks blocked), last command and exit code, files written and how many fell outside "May change", token use including cache hit rate. |
| Questions | Every question with id, kind, status (pending, deferred, resolved, cancelled), age and resolution time. |
| Subagents | Each child agent with working/idle, model, effort, start time, interaction count, last activity. |
| Hand-off | The latest hand-off text, titled with the turn it came from. |
| Commands | Copyable foreman commands for this run (answer, steer, followup, and so on). |
| Feed | The event stream, newest at the bottom. Title shows `following` or `paused · f to follow`. |

Feed entry types: a muted timestamp, then commands as `…` (open), `✓` (exit 0) or `×N` (exit N); file writes as `write <path>`; Codex messages as plain text; questions and hook blocks as small framed notes with a badge; and state changes, turn starts, resolutions, retries, steers and interrupts as muted one-liners. Token usage and protocol chatter are hidden. The feed holds the latest 1000 events.

If the run was archived the screen says so; if the daemon is gone, three lines in the middle say what is happening, when it re-checks and the `foreman status <name>` command that would start supervision.

### 3.6 Keys

| Key | List | Detail |
|---|---|---|
| `↑` `↓` or `k` `j` | Move selection | Scroll the focused pane |
| `Enter` | Open detail, or expand a "7 idle runs older than 24h" line | |
| `Tab` | | Move focus to the next pane |
| `PgUp` `PgDn` `Home` `End` | Jump selection | Scroll the focused pane |
| `a` | Toggle attention-only (hide runs that need no one) | |
| `f` | | Toggle follow on the feed |
| `Esc` | Close help | Back to list |
| `?` | Help overlay | Help overlay |
| `q` | Quit | Quit |
| `Ctrl-C` | Quit, exit 130 | Quit, exit 130 |

The help overlay is a centred frame with the key table, the glyph legend, and a line pointing scripts to `foreman status --all`.

### 3.7 Visual system as shipped

One dark theme, painted over the whole screen so contrast does not depend on the user's terminal theme. It is a deliberate port of foreman's website "site office" design.

| Token | Hex | Use |
|---|---|---|
| console | `#121412` | Screen |
| console-2 | `#1B1E1A` | Header, footer, selected row, chips |
| console-line | `#2D322B` | Rules and borders |
| console-fg | `#E4E8E0` | Text and focused borders |
| console-muted | `#9AA294` | Meta text |
| signal | `#FF5B14` | A person is needed. Nothing else is ever orange. |
| state-running | `#6FA8FF` | Running |
| state-done | `#5CC98A` | Idle after success |
| state-failed | `#FF7A70` | Failure |
| state-interrupted | `#E2C04F` | Interrupted, unknown, caution flags |

Rules that carry over to v1 unless changed on purpose: the orange rule; no dim, italics or blink; bold only for names, titles and keys; right-aligned fixed-width numbers; selection is a full-width `console-2` fill with no coloured stripe; truncation always ends in `…` and rows never wrap; one 100 ms animation tick, running only while something on screen animates. Motion: braille spinner for running, `◐◓◑◒` for starting, pulsing square for waiting, `⠿`/`⠶` for working subagents.

Colour fallbacks: truecolor, 256-colour, 16-colour (no background; orange becomes bright red with bold), and `NO_COLOR` (no colour, selection as inverse video, glyphs and weight carry all meaning).

Responsive layout:

| Width | Behaviour |
|---|---|
| 120 or more | Full row; detail panes side by side with the feed |
| 80 to 119 | Budget bar shrinks to 6 cells, turn kind drops, detail panes stack |
| under 80 | Glyph, name, state and age on line 1; activity on line 2; only the most urgent flag; subagents become a count |

Height under 24 rows collapses the footer and limits attention notes to one. At 40 rows or more the feed shows 30 or more entries.

## 4. What the monitor cannot do today

These are the gaps v1 has to take a position on.

- It cannot act. Answering a question, steering, interrupting, following up or archiving all require leaving the monitor and running a command. The monitor shows the command to copy, nothing more. This is the biggest gap and also a deliberate design: a read-only monitor never changes a run and never keeps the daemon alive.
- There is no search, filter by state or repo, or sort. The only filter is attention-only (`a`).
- There is no history. Runs older than 24 hours collapse into a count; archived runs are gone from the list.
- There is no view of the code change. The detail screen counts files written but cannot show the diff or list the files.
- It does not notify. An orange note only helps if the monitor is on screen.
- It has one layout and one theme (dark). No light theme and no configuration.
- The feed cannot be searched, filtered by event type, exported or copied from.
- Help is one overlay. There is no first-run guidance and no empty-state teaching beyond a line and a command.
- Mouse input is not part of the design. Nothing in the contract mentions it.
- It shows one machine only.

## 5. Who this is for

| Persona | Situation | What they need from the monitor |
|---|---|---|
| Delegating developer | Has Claude Code handing three to ten tasks to Codex across one or two repos, and is doing something else in another window or pane | Glance and know: is anything blocked, is anything stuck, is anything done. Open one run and understand it in under 30 seconds. |
| Supervisor of a long run | One big refactor running for an hour | Confidence it is progressing and a feed they can read without asking an agent. |
| Reviewer after the fact | Run finished while they were away | What did it do, what did it decide when nobody answered, what did it change outside scope. |
| Evaluator | Heard about foreman, ran one task | Understand what foreman is from the screen alone. The monitor is likely the first thing a visitor sees that explains the product. |

Hypothesis: most real time in the monitor is spent in a tmux or terminal split next to the agent session, left open all day. That makes glanceability, low CPU and calm motion the quality bar, more than navigation depth.

## 6. Jobs to be done

- When I have several runs going, I want one screen that tells me whether anything needs me, so I can keep working elsewhere without polling. (Functional: triage. Emotional: calm, not anxious.)
- When Codex asks a question, I want to read it with its context and answer it right there, so a run is not stalled while I look up a command. (Functional: unblock. Emotional: in control.)
- When a run has gone quiet or looks wrong, I want to see the evidence and stop or redirect it, so I do not waste an hour of budget. (Functional: intervene. Emotional: safe.)
- When a run finishes, I want to see what it changed and decided, so I can accept or reject it quickly. (Functional: review.)
- When I look at foreman for the first time, I want the screen to teach me the model, so I do not need to read docs. (Functional: onboarding.)

## 7. Experience qualities

Chosen qualities for v1: transparent, calm, and safe. Powerful is a stretch goal, not a driver.

- Transparent: the user can always see what a run is doing and how fresh the data is. Already the strongest quality of the MVP.
- Calm: it should be pleasant to leave open all day. Motion only where work is happening, orange only where a person is needed. Already a strength; v1 must not erode it when adding features.
- Safe: if the monitor gains actions, nothing destructive happens by accident and the user always knows what a key will do before pressing it.

Tension to resolve consciously: calm and transparent versus powerful. Every added panel, key and indicator competes with the glance test. Design should state a density budget, for example "the list at 100 columns shows no more than N distinct kinds of information per row".

## 8. v1 proposal

Everything below is a proposal for product and design to challenge. Grouped by theme, with a recommendation on priority. "Must" means the monitor is not a v1 without it.

### 8.1 Must have

1. Act from the monitor. Answer a question (write or paste text, or pick a file), defer it, steer a running run, follow up a finished one, and interrupt. Each action is a confirmed, labelled step with the exact result shown after. This changes the product's character from observer to cockpit, so see decision D1 below before design starts.
2. A real answer flow for questions. The attention note and the Questions pane should offer an inline editor, show the full question text (the list truncates it today) and show what a deferred question was resolved with.
3. Filtering and search in the list: by state, by repo, by text on run name and activity. The attention-only toggle becomes one filter among several.
4. Run history. A way to see archived runs and older idle runs without expanding a count, with a clear "this run is done" treatment.
5. See what changed. A files view in detail listing changed files with a marker for outside "May change", and a way to read the diff, at least by handing off to the user's pager or `git diff`.
6. Better empty, first-run and error states: no runs, no daemon, daemon outdated, Codex not logged in, repo not trusted. Each says what happened, what to do and shows the command.
7. A designed help and onboarding path, including a legend that is reachable from every screen.
8. An accessibility baseline: full function under `NO_COLOR`, no reliance on colour alone, a documented high-contrast variant, and screen-reader-friendly plain output through the existing snapshot path.

### 8.2 Should have

- Notifications for a run that starts waiting, finishes or fails: terminal bell, title or tab-badge update, and optionally a desktop notification when the monitor is not focused.
- Mouse support (click a row, scroll a pane) as an addition to keys, never required.
- A light theme and a user-chosen theme, keeping the orange rule.
- Configuration (default view, grouping, attention-only default, motion off) in the existing foreman config, not a new file.
- A command palette (`:` or `/`) listing every action with its key, as the discoverability layer for section 8.1.
- A compact "one-line status" mode suited to a narrow tmux pane or status bar.
- Token and time cost views per run and per group.

### 8.3 Won't have in v1

- Multi-machine or remote supervision.
- A web or desktop GUI. The terminal is the product.
- Editing the contract or the worktree from the monitor.
- Starting new runs from the monitor. Run creation needs a written contract and stays in the delegating agent's workflow, unless research shows developers want it (open question Q2).
- Running without a TTY. The snapshot path already covers scripts.

## 9. Decisions the team needs to make first

Design cannot mock the right thing until these are settled.

D1. Does the monitor stay read-only? The 0.2.0 promise is that it "never starts or keeps alive a daemon" and the architecture enforces it with a passive connection. Acting means an active connection, which keeps the daemon alive while the monitor is open and changes idle shutdown. Options: (a) stay read-only and make copying commands excellent; (b) add actions behind an explicit mode switch that visibly changes the header; (c) always allow actions. Recommendation: (b), because it keeps the safe passive default and makes action an intentional, visible state. This is a one-way door for user trust, so decide it before anything else.

D2. Who is the primary user: the developer, or the agent's human operator in a pane next to Claude Code? The answer decides whether the list or the detail screen is the home screen.

D3. How much of the attention model moves into the monitor: only display, or also routing (for example, "answer from here" while the agent is also waiting on the same question)? Two actors answering the same question needs a rule.

D4. Which views get a full screen versus an overlay or pane: files/diff, history, help, palette.

D5. How the name `monitor` relates to `status`, `events --follow` and `wait`. They read the same data. Decide whether the monitor is the human surface and the others stay agent surfaces, and say so in help text.

## 10. Design deliverables requested

- Mocks at 70, 100 and 140 columns, and at 24 and 40 rows, for: list (live, saved, reconnecting), list with attention notes, detail, help, and each empty or error state. The existing breakpoints are a starting point, not a constraint.
- The same screens with `NO_COLOR` and 16-colour.
- A flow for answering a question, one for interrupting a run, and one for reviewing a finished run, from first key to confirmation.
- A motion spec: what animates, at what rate, and what stops when nothing is running.
- A glyph and colour legend that extends section 3.4 and keeps the orange rule.
- A decision on theming, including whether a light theme is in scope.
- Notification and focus behaviour specified as states, not just text.

Constraints the design inherits: a character grid only, so no images and no sub-cell positioning; monospaced width, with wide characters measured by terminal width; 80 columns must remain usable; no dim, italics or blink; truncation with `…`, never wrapping a row; and every colour token must stay in step with the website's tokens (a test fails if they drift, so a change goes to the site design first or in the same change).

## 11. Research, assumptions and risks

### Comparable tools

These are from general knowledge, not fresh research; check before quoting them externally.

| Tool | Pattern worth studying | Where it differs |
|---|---|---|
| k9s | Resource list, drill-in, `:` command palette, `/` filter, actions on the selected row, a visible hint bar | Kubernetes objects are long-lived; runs here carry a question-and-answer loop |
| lazygit and lazydocker | Multi-pane layout, always-visible key hints, actions bound to single keys with confirmation | Many panes at once; the monitor's calm quality argues for fewer |
| htop and btop | Glanceable live metrics, low overhead, sort and filter keys | Numeric, not narrative |
| tmux and Zellij status lines | Ambient status in a few characters | A target for the compact mode |
| `gh dash` | Cross-repo list with sections and filters | Not live-supervised |
| Claude Code's own agent and background-task views | The closest neighbour for users: lists of running agents with status | The monitor must feel adjacent to it, not duplicated |

Pattern to meet rather than break: a hint bar that always shows the keys that work right now, `/` for filter, `:` or `ctrl-p` for a palette, `?` for help, and single-key actions with confirmation. Developers who use these tools will try those keys first.

### Assumptions

| Assumption | Confidence | How to check |
|---|---|---|
| The monitor is left open for long periods beside an agent session | Medium | Ask the first ten users; add opt-in local counters of session length if telemetry is ever added |
| Answering questions is the action users most want in the monitor | Medium | Watch what people copy from the Commands pane and attention notes |
| Users run more than one run at a time often enough that the list matters | Medium | Interview; the maintainer's own use is the only evidence today |
| A calm, mostly read-only screen is part of why users like it | Low | Test an actions prototype against the current build with the same users |

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Actions make the monitor busy and lose the glance test | High | High | Set a density budget; test glanceability at 100 columns with five seconds of viewing |
| Acting and the delegating agent collide on the same question | Medium | High | Decide D3; show who else is waiting and use the existing late-answer semantics |
| Active connection keeps the daemon alive and surprises users | Medium | Medium | Visible mode switch (D1); show daemon lifetime in the header |
| Terminal differences break layout and colour | High | Medium | Keep the fallback matrix, golden render tests and `NO_COLOR` tests as release gates |
| Rendering cost grows with features | Low | Medium | Keep the benchmark (10-run frame, 100 renders under a stated budget) |

## 12. Success criteria

No telemetry exists, so these need a measurement plan before they are targets. Proposed outcome measures:

| Metric | Proposed target | Measurement |
|---|---|---|
| Time from "a run is waiting" to "the question is answered" | Down by half versus copying a command | Timing in usability sessions |
| A first-time user can say what each of the three states means with no docs | 5 of 5 | Moderated test with the glance screen |
| Users who use the monitor in a second session within seven days | Majority of evaluators | Interviews until opt-in telemetry exists |
| Glance test: identify the run that needs attention on a 10-run list | Under 3 seconds | Timed test |
| Zero layout breaks in the golden suite at 70, 100, 140 columns and under `NO_COLOR` | 100% | Existing CI |

## 13. Open questions

- Q1. Is any form of telemetry acceptable for a local developer tool? Without it, the success table above relies on interviews. Owner: product.
- Q2. Should the monitor ever start a run? Owner: product, after D1.
- Q3. Is a light theme in scope given the website is light with dark console panels? Owner: design.
- Q4. Should the monitor surface cost (tokens, plan usage) given Codex runs on a ChatGPT login? Owner: product, after checking what Codex exposes.
- Q5. What is the right name for the three connection modes in user-facing copy? `saved state` is accurate but internal. Owner: design and product.
- Q6. Which terminals and multiplexers are officially supported for v1 (iTerm2, Terminal.app, Ghostty, kitty, tmux, Zellij, Windows)? foreman ships macOS and Linux only today. Owner: product.

## 14. Handoff

### For design

Experience qualities: transparent, calm, safe.
Reference products: k9s (palette, filter, hint bar), lazygit (single-key actions with confirmation), btop (glanceability).
Key interactions: glance at the list, open a waiting run, answer, return; interrupt a stuck run; review a finished run.
Source of truth for what exists: this document, `docs/design/monitor.md`, and the render snapshots under `tests/__snapshots__/monitor-*.snap`.
To see it live: `foreman monitor` in any repo with runs, or `bun run dev monitor` from this repository. `scripts/` includes a quiet replay script used by the tests that can feed a fixture daemon.

### For technical planning

Problem: the monitor shows state but cannot act, search or review, so developers leave it to do each of those.
Goal: the monitor is where a developer supervises and steers delegated runs, without losing its glance-and-leave quality.
Scope: section 8.1 and the decisions in section 9.
Technical constraints: passive connections only honour read-only requests (`Ping`, `Overview`, `Detail`, `Events`, `Status`); any other request makes the connection active permanently. The TUI is an Ink view over a pure view model in `src/core/monitor/model.ts`, loaded by dynamic import and rendering only from the `Terminal` service. Colour tokens are checked against `site/src/styles/global.css`.
Dependencies: decision D1, the agent-facing commands (`answer`, `defer`, `steer`, `followup`, `interrupt`) that the actions would reuse, and Codex protocol support for anything touching cost.

---

## 15. The ideal dashboard

This section is the target the v1 scope in section 8 is cut from. It starts from the questions a developer asks when they look at a screen of running agents, says which answers foreman can give today, and flags the ones it cannot yet.

### 15.1 The questions the screen must answer

In order of how often they get asked:

1. Does anything need me right now?
2. Which agents are working, and on what?
3. Which model and settings is each one using?
4. Is each one making progress, or stuck?
5. How far along is it, and how much is left?
6. What has it done so far, and what has it changed?
7. How much of its budget is gone, and what is it costing?
8. What happened to the ones that finished?

The list screen answers 1 to 4 and part of 7. The detail screen answers 6. Nothing answers 5 or 8 well.

### 15.2 What data exists for each question

This is the main input for design, because several things people will ask for (progress, time remaining) have no source today. A mock should not draw a number that foreman cannot compute.

| Wanted | Available today | Gap |
|---|---|---|
| What the agent is, which model | Per run: model, effort, speed tier, sandbox mode. Per subagent: path, model and effort if different | None |
| Status | Eight states, state age, quiet flag, retry reason, hooks blocked | None |
| What it is doing now | Open command and its age, latest commentary, last outcome | Only the latest item; no short rolling "recent steps" in the list |
| What it is working on | The contract (task and file scope), shown in detail only; run title if set | The list never shows the task. A run named `fix-hooks` is the only clue |
| Progress | Turn number and kind, elapsed time against the turn budget, counts of commands and files written, token totals | No measure of completion. Codex tasks have no known length |
| Remaining work | Remaining budget time | No estimate of work left. Foreman does not read any plan or checklist from Codex today. Whether Codex emits one that foreman could surface needs an engineering check (Q7) |
| What it changed | Count of files written and how many fell outside scope | No file list, no diff, no line counts in the monitor |
| Cost | Token totals including cached and reasoning tokens | No money or plan-usage figure; rate and usage-limit retries are visible as a flag only |
| History | Run records persist on disk; old idle runs collapse | No past-runs view, no durations or outcomes over time |

Design rule that follows: show elapsed against budget as a bar, never as "percent complete". A budget bar says how much time is spent; a completion bar claims how much work is done, and foreman would be guessing. If a plan or checklist can be sourced from Codex later, it becomes the one honest progress display. Until then use activity signals, which are true.

### 15.3 The three altitudes

The ideal dashboard works at three distances, each tied to a reason someone looks.

Fleet (the whole machine): one line of totals, then what needs a person. Answers question 1 in under two seconds from across the room.

Run (one row): who, what, status, pace. Answers 2 to 4 for every run without opening anything.

Run detail: the evidence. Answers 5 to 8 for one run.

### 15.4 Target list screen

Compared with today's: each row gains the task in plain words, a pace sparkline, a progress cluster and the model, and the header gains a fleet summary. The selected run opens a preview strip at the bottom, so most questions are answered without leaving the list.

```
››› foreman 0.4.0     daemon up 2h14m  ·  4 working  ■ 1 waiting  ✓ 2 done  × 0 failed        ctx 38%  1.2M tok today
╭─ ■ waiting  fix-hooks q2 · 3m · defers in 12m ───────────────────────────────────────────────────────────────╮
│ Keep the existing hook API, or can I change the signature of runHook()?              [a] answer  [d] defer   │
╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
── claude-codex ───────────────────────────────────────────────────────────── 3 working · 1 waiting ──
   RUN                MODEL · EFFORT   STATUS         TASK                           PACE      PROGRESS          BUDGET
 ■ fix-hooks          sol · high       waiting 3m     Fix hook handling              ▁▂▅▇▅▂    t2 · 14 cmds      ━━━━━━───  38/60m
 ⣾ add-retry          sol · high       running 12m    Retry failed daemon connects   ▂▃▅▆▇▇    t1 · 31 cmds      ━━━━────   24/60m
    … bun run test · 20s                              ▸ 3 files written · 0 outside scope
    ├─ ⠿ /root/acceptance_tests   sol · med   working 20s
    └─ · /root/review             idle 2m
 ⣾ docs-pass          mini · low       running 4m     Update README command table    ▁▁▂▃▃▂    t1 · 6 cmds       ━─────────  4/30m
 ✓ rename-flags       sol · high       done 6m        Rename --from to --base        ·         t1 · 22 cmds      ━━━━━━━━──  44/60m   2 files · review
── other-repo ──────────────────────────────────────────────────────────────── 1 working ──
 ⣾ migrate-config     sol · high       running 31m    Move config to schema v2       ▂▂▃▂▅▇    t3 · 88 cmds      ━━━━━━━━━─  54/60m ⚠
╭─ add-retry ─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Task    Retry failed daemon connects with backoff, no change to the wire protocol.                          │
│ Now     … bun run test · 20s     Last said  “Tests for the backoff are in, running the suite.”              │
│ Files   src/daemon/client.ts  +42 −7    tests/client.test.ts  +61 −0    1 more                              │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
↑↓ select  Enter open  a answer  i interrupt  s steer  / filter  : palette  ? help  q quit        updated 0.4s ago
```

Everything in the mock that is new is a proposal; the PACE sparkline, per-file line counts, `ctx`, tokens today and the preview strip are not in 0.2.0. The ⚠ on `migrate-config` marks a budget past 80%.

### 15.5 Features, by what they do for the user

Understand the fleet at a glance
- A fleet summary in the header: counts by state, plus the one number that matters most, how many runs need a person. Always visible, never scrolled away.
- Attention first: pending questions, blocked runs and runs about to hit their budget are pinned above the groups, in a fixed order of urgency (needs an answer, about to be deferred, failed, over budget, quiet).
- Grouping the user can change: by repo (today), by state, or flat by recency. Sorting by state age, budget used or name.

Know who is working and on what
- A task line per run, taken from the contract title or its first line, so rows are recognisable by purpose and not only by name.
- Model, effort and speed tier in a column, with a visible difference when a subagent uses something other than its parent.
- Subagent tree under each run with the same columns, collapsed to a count when there are many.
- A pace sparkline showing events per minute over the last 10 to 15 minutes. It reads as "alive, bursting, or flat" without any claim about completion.

See progress honestly
- Budget bar as today, with the elapsed and limit labelled.
- A progress cluster of facts that are always true: turn number, commands run, files written, and a failure count. No percentage.
- A quiet marker with its duration, and a stuck heuristic that turns amber when a command has been open far longer than usual or the same command fails repeatedly. Needs engineering to define; flag only, never auto-act.
- When a plan or checklist source exists (Q7), a step counter such as `4/9 steps` with the current step named. This is the single most valuable addition and the least certain.

Inspect one run
- Detail keeps its panes and adds a Files pane (path, lines added and removed, a mark for outside scope) and a Diff view opened from it.
- The feed gains filters (commands, files, messages, questions) and in-feed search.
- A timeline strip across the top of detail showing turns, questions and state changes over the run's life, so "when did it stall" is visible.
- Question context: the full text, the few events leading up to it and the command already prepared for answering.

Act
- Answer, defer, steer, follow up, interrupt and archive from the list and the detail, each confirmed, each showing the resulting event (decision D1).
- Bulk actions on a filtered set, for example archive all finished runs in a repo.

Finished work
- A done state with a hand-off summary on the row, a count of files changed and an explicit review path: open diff, mark reviewed, archive.
- A History view of past runs with outcome, duration, turns and token total. It also supplies the evidence for any future "typical duration" estimate.

Stay informed when not looking
- Bell, terminal title and optional desktop notification on a new question, a failure or a completion, configurable per event.
- A compact one-line mode for a narrow pane or status line: `1 waiting · 3 working · 2 done`.

Find things
- `/` filters by name, task text, repo, state or model. `:` opens a palette that lists every action with its key.

### 15.6 What "how much work is left" can honestly show

Because this is the question people will most want, and the data is thinnest, the options in order of honesty:

| Option | Source | Honest? |
|---|---|---|
| Time left in the turn budget | Budget minus elapsed | Yes, and it is a ceiling, not a forecast |
| Step counter from a Codex plan | A plan or todo stream, if Codex emits one | Yes, if the plan is real and kept current |
| Typical duration for this kind of task | Past runs in History | Weak at first, improves with data; show as a range and label it |
| A percentage computed from tokens or commands | Nothing real behind it | No. Do not ship it |

### 15.7 Principles for the ideal screen

- The orange rule stays: orange means a person is needed, on every new element.
- Every number on the screen has a source foreman can name. If it cannot be computed, it is not drawn.
- The list stays readable at 100 columns with 10 runs. New columns drop in a fixed order as width shrinks (budget label, pace, progress, model, task), and the name, state and status never drop.
- The preview strip and detail are the only places text wraps or runs long; rows never wrap.
- Motion shows work, not decoration. A pace sparkline updates at most once a second.

### 15.8 Open questions specific to the ideal dashboard

- Q7. Does Codex expose a plan or todo stream that foreman can read and show? Engineering to check the app-server protocol before design commits to a step counter.
- Q8. Is a line-count diff stat cheap enough to compute continuously, or only on demand? It requires a worktree read, and the monitor currently avoids worktree refreshes in detail.
- Q9. Where does the task line come from? The contract's first heading is the likely source; confirm it is reliably present.
- Q10. Is "tokens today" and a context-window figure available per run, or only totals?
