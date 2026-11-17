# Build: monitor-v1

Started: 2026-11-16 22:11 (epoch 1794888674). Timebox: none. Landing branch: feat/monitor-v1 (integration worktree `.claude/worktrees/monitor-v1`).
Gate: `rr run --local "bun run check"` (160s). Filtered tests: `bun run test:unit <path or name>`. Typecheck: `bun run typecheck`.
Worktree setup: `bun install --frozen-lockfile`.
Lanes: Codex runs through foreman (`gpt-6.1-sol`, high effort, fast tier), one managed worktree each, `--from feat/monitor-v1`.
Scaffold commits: phase 1 c886efe, DA fixes on top.

## Spec

Source: `/Users/riley/Projects/claude-codex/docs/specs/2026-11-16-foreman-monitor-v1.md` (sections 8, 9, 15) and the design mocks at https://claude.ai/artifact/W9sRfcUjQHLrtfZWiifR26 (boards Main, Answer, Detail, Review, Palette, Interrupt, Narrow, States, NoColor). v1 turns `foreman monitor` from a read-only observer into the place a developer supervises and steers delegated runs, without losing the calm glance-and-leave quality.

In scope (grill):
- Phase 1 is act mode plus answer and defer.
- D1 option (b): the monitor opens watching (passive, as 0.2.0). The first action key asks once to switch to acting; acting holds an active connection that keeps the daemon alive while the monitor is open; `w` returns to watching.
- Text input uses `ink-text-input` 6.0.0 (Ink's author, `ink>=5` peer). Long answers wrap visually; multi-line answers go through ctrl-e `$EDITOR` (phase 2).
- No timebox. Phases land on feat/monitor-v1; merge to main only when the user asks.

Out of scope for v1 (spec 8.3): multi-machine, GUI, contract editing, starting runs, non-TTY live view. Also cut: notifications, mouse, light theme, config (spec 8.2 should-haves) unless time allows after phase 6.

Assumptions (user can override):
- D3, two actors: first answer wins. The monitor sends `Answer` with `expectOpen: true`; if the question was already resolved the daemon refuses with RunConflict and nothing is sent, the draft is kept and the box says so. The CLI's late-answer and correction behaviour is unchanged.
- The 0.2.0 `a` (attention-only) key moves to `!` so `a` can mean answer (mocks: Palette board, "! needs me"). Phase 4 folds it into `/needs:me`.
- `d` defers immediately once acting (defer is recoverable: a late answer is still accepted). Destructive actions (interrupt, archive) get a confirm box in phase 2.
- Acting is unavailable without a live daemon of this build. The monitor never starts or replaces one; it shows a notice naming `foreman status <name>`.
- Answer attribution ("resolved from the monitor") is phase 2: it needs a source field on question resolution events.
- "Leading up to it" context in the answer box needs detail events for the run; phase 2.
- Lanes write their own tests first from the case list below (no separate test-author runs); the orchestrator reviews tests before merge. Tests are locked against weakening after review.
- Codex CLI is 0.169.0 while foreman's protocol is checked against 0.166.0 (`foreman doctor`: protocol matches false). Runs proceed; flagged to the user, no workaround.

Error model: every action failure becomes an `ActOutcome { ok: false, text }` shown as a notice line, never a crash and never a silent drop. `openActing` fails with DaemonUnavailable (no daemon, outdated build, socket refused) and the monitor stays watching. `send` fails with RunConflict (already resolved, from `expectOpen`), RunNotFound, or DaemonUnavailable; the executor maps the error's `detail` (or its errorTable safe message) to the notice text. A failed answer keeps the draft and the box open. A daemon that dies mid-acting drops the monitor to watching with a notice; the feed's own reconnect logic is unchanged.

## Contracts (scaffold commit)

    src/schemas/daemon.ts          Answer gains optional expectOpen: true
    src/core/monitor/act.ts        pure acting state, reducer and view (ActState, ActIntent, ActOverlay, ActView, reduceAct, actView)
    src/core/monitor/acting.ts     the acting connection: openActing(home) -> ActingSession { send }; the only monitor module that sends active requests
    src/core/monitor/model.ts      State.act, ViewModel.act, Message includes ActMessage; reduce/view delegate to act.ts
    src/tui/act.tsx                (new, phase 1 lane c) mode chip, confirm box, answer box, notice line
    src/tui/screen.tsx             places the act components; key routing while an overlay owns input
    src/tui/run.tsx                executes ActState.inFlight through an injected acting opener
    src/commands/monitor.ts        wiring only: passes openActing(config.home) to runMonitor

## Phases

### Phase 1: act mode, answer and defer (MVP)

Demo: in this repo, start a fake or real run that asks a question, then `bun run dev monitor`; press `a`, confirm `y`, type an answer, Enter. The header chip reads `◆ acting`, the run resumes, the notice reads `✓ answered <run> <q>`. `w` returns to `◇ watching`.

Test cases:
- Daemon: Answer with expectOpen on an open question resolves it as today ("answered").
- Daemon: Answer with expectOpen on an answered, auto-answered, late-answered, corrected, cancelled or superseded question fails RunConflict, records no event and starts no follow-up turn.
- Daemon: Answer with expectOpen on a deferred question is accepted as a late answer (Review board: answer late starts a follow-up turn).
- Daemon: Answer without expectOpen on a resolved question still produces a late answer/correction (regression).
- Acting: openActing with no daemon fails DaemonUnavailable and does not create a socket or start a daemon.
- Acting: openActing against a daemon of another build fails DaemonUnavailable and does not stop or replace it.
- Acting: while the session scope is open the daemon counts an active connection (does not idle-exit); closing the scope releases it.
- Acting: send answer and send defer reach the daemon and return outcome text naming run, question and byte count for answers.
- Model: `a` in watching with a waiting selected run opens confirm-acting; `y`/Enter sets inFlight enter-acting; ok outcome sets mode acting and opens the answer box on that question.
- Model: `a` with no selected waiting run targets the first attention note's question; with no pending question anywhere, a notice says nothing is waiting and no overlay opens.
- Model: `a` or `d` while the feed is Saved/Reconnecting/outdated shows the "acting needs a running daemon" notice with `foreman status <name>` and no confirm.
- Model: confirm `n`/Escape closes the box, mode stays watching, nothing in flight.
- Model: enter-acting failure outcome leaves mode watching, closes the box and shows the failure text.
- Model: draft messages update drafts["<run>/<q>"]; Escape closes the answer box and keeps the draft; reopening restores it.
- Model: Enter or ctrl-s with a blank (whitespace-only) draft sends nothing; with text sets inFlight answer with the untrimmed text.
- Model: ok answer outcome closes the box, deletes the draft and shows the ok notice; failure keeps box and draft and shows the failure text.
- Model: ctrl-d in the answer box sets inFlight defer for that question.
- Model: `d` in acting with a target sets inFlight defer directly.
- Model: keys other than the overlay's own are swallowed while an overlay is open; action keys are ignored while inFlight is set.
- Model: `w` in acting with no overlay sets inFlight leave-acting and mode watching.
- Model: `!` toggles attention-only (moved from `a`); the next handled key clears a notice.
- Model: actView chip text `◇ watching` / `◆ acting`; answer view shows run, question id, kind, full question text (not truncated to one line), "waited Xm · defers in Ym", draft, sending flag.
- TUI: header renders the chip; acting adds "daemon stays up while this monitor is open · w to watch only" when wide enough, dropped first as width shrinks.
- TUI: confirm box and answer box render centred over the list at 140x40 and 80x24 without wrapping rows; NO_COLOR keeps them legible (glyphs and weight only).
- TUI: while the answer box is open, typed characters go to the text input and not to list keys (typing `q` does not quit; `j` does not move selection).
- TUI: footer shows the overlay's hints while open (`enter send  ctrl-d defer  esc cancel`), and `a answer  d defer  ! needs me` in the list.
- TUI/run: an inFlight enter-acting calls the injected opener once and reports ok; leave-acting closes the session scope; answer/defer call session.send and report its text; a failure reports the error detail; quitting closes the session.
- Help overlay lists `a`, `d`, `w`, `!`.
- Acting lost: when the acting session's socket closes unasked, the executor sends `acting-lost`; the model returns to watching, closes any confirm box, keeps an answer draft and shows the failure notice.
- Model: a feed update showing the answer box's question no longer pending marks the view `resolved` and Enter sends nothing; drafts survive feed refreshes.
- TUI: with the answer box open, ctrl-d, ctrl-s and Escape reach the reducer and are not inserted as text; ctrl-c quits.
- Every switch from watching to acting is confirmed, including after `w`.

| Lane | Size | Owns files | Reads | Tests | Done when |
| --- | --- | --- | --- | --- | --- |
| a | SM | src/supervisor/index.ts (answer path only), src/supervisor/questions.ts if needed, src/daemon/client.ts (new exports only), src/core/monitor/acting.ts | contracts, tests/monitor-detail-daemon.test.ts | tests/monitor-acting.test.ts, tests/supervisor-answer-expect-open.test.ts | daemon and acting cases pass |
| b | SM | src/core/monitor/act.ts, src/core/monitor/model.ts | contracts, tests/monitor-model.test.ts | tests/monitor-act-model.test.ts, tests/monitor-model.test.ts (`a`→`!` only) | model cases pass |
| c | SM | src/tui/act.tsx, src/tui/screen.tsx, src/tui/run.tsx, src/commands/monitor.ts, src/tui/detail.tsx (footer hints only) | contracts, tests/monitor-render.test.ts, tests/monitor-run.test.ts | tests/monitor-act-render.test.ts, tests/monitor-act-run.test.ts, snapshot updates for footer/header | TUI and run cases pass |

Lane c renders from hand-built ViewModels and a fake opener, so it does not wait on lanes a and b. Full contracts are in the scratchpad (`contract-<lane>.md`) and quoted into each run.

### Phase 2: the rest of acting

Steer (`s`), follow up (`F`), interrupt (`i`, confirm box per Interrupt board), archive (`x`, confirm), ctrl-e `$EDITOR` for long answers and steers, answer box "Leading up to it" context, answer/defer attribution recorded on QuestionResolved (`source: "monitor"`) and shown in detail and to `foreman wait`.

| Lane | Size | Owns files |
| --- | --- | --- |
| a | SM | supervisor attribution, acting.ts send for steer/followup/interrupt/archive |
| b | SM | act.ts reducer and view for the new actions and confirm boxes |
| c | SM | tui act components, $EDITOR hand-off |

### Phase 3: list refresh

Task column (contract first heading), model column, progress cluster (turn, cmds, failures), pace sparkline (events per minute over 12 minutes, from the daemon overview), pinned attention rows for failed, over-80%-budget and quiet runs, preview strip for the selected run with file numstat on selection. Column drop order per spec 15.7.

### Phase 4: find things

`/` filter (state:, repo:, model:, text), `:` palette listing every action with its key, `h` history of archived and older runs.

### Phase 5: inspect and review

Detail Files pane (numstat, outside-scope marks), diff view (`d` file, `D` all in `$PAGER`), timeline strip, feed filters 1-5 and feed search, Review screen for finished runs (hand-off, "decided without you", files, diff, mark reviewed, archive).

### Phase 6: first run, narrow and fallbacks

First-run/no-daemon screen that doubles as the legend, `foreman monitor --line` one-line mode, NO_COLOR treatment per NoColor board, 80-column layout per Narrow board, docs (README, docs/design/monitor.md, AGENTS.md "read-only" wording).

## Log

- Phase 1 tagged `phase-1`. Lanes act-daemon, act-model, act-tui, act-e2e (Codex). Accepted choices: act-view.ts split; input.tsx, header.tsx, answer-input.tsx, act-frame.tsx splits; component-local remount counter for ink-text-input (it inserts ctrl-modified letters and moves its private cursor); long questions capped with … at 80x24; deferred questions stay answerable with expectOpen. Refactors: deduped pending lookup and conflict message, removed a manual child scope in openActive. Integration fixes: footer shows `! all runs` while filtering, PTY test keys. Review found and fixed a deferred-answer double follow-up race.
- Phase 2 scaffold `fad75b4`. "Leading up to it" context moved to phase 5. Interrupt confirm omits the command count unless the run's detail is loaded. ctrl-e may reset the input cursor to the end.
- Phase 2 tagged `phase-2` (gate 1,650 tests). Lanes act2-daemon, act2-model, act2-tui. Accepted: act-reducer/act-target/act-confirm splits, ComposeTarget.stateSince, Ink suspendTerminal for $EDITOR, $EDITOR arguments parsed with shell quoting, ctrl-e may reset the caret. Known limitation: cooked-mode editors (ed) pass ctrl-c to the monitor's SIGINT handler and quit it. Refactor: reverted unrelated doc comments in digest/supervisor. Open: `status --all` overview has no interruption attribution. Stress-test timeouts in lane full-suite runs came from parallel load; the integration gate passes.
- Phase 3 tagged `phase-3` (gate 1,718 unit tests plus e2e). Lanes list-daemon, list-model, list-tui, plus act2-e2e for phase 2. Accepted: in-memory command/file/pace counters on Run rebuilt from the journal on load; PaceWindow module; five list model modules; morePinned; retained preview commentary across reconnects; viewport counts pinned rows, column headers and the preview. Integration fixes: pinned rows drew the glyph and name twice (model text now carries only the reason), pinned block height counts the +N more line, morePinned wired, name/state regexes allow the model column, the command test waited on preview text that now appears in the list. Refactor: reverted unrelated doc comments in registry/overview/disk-overview. Contract changes from here: size guidance is for production files only; doc blocks only on exports a lane adds.
- Phase 4 tagged `phase-4` (gate 1,839 unit tests plus e2e). Lanes find-history, find-model, find-tui. Accepted: history reads at most `limit` journals by run.json mtime and includes `unknown` runs; filter-text, State.clipboard and helpKeys added by the model lane; history shares the list filter text. Review fix: `a`/`d` now target the selected run whenever it has a pending question (was: only when waiting), act-target.ts scope widened for it. Integration: added the `palette-query` message (the TUI's input sends whole text), group headings use the model summary for filter counts, clipboard requests wired to the OSC 52 executor, onFind wired. model.ts is ~1,180 lines of wiring; flagged for the final review.
- Local setup: codex runs only under mise Node 24 while the repo pins Node 26; delegated reviews use `MISE_NODE_VERSION=24.21.0` on the one command.

- DA (sonnet): applied deferred-is-answerable for expectOpen, acting-lost message, resolved-while-typing flag, key-routing and confirm-after-w cases. Dropped the package.json ownership finding (dependency is in the scaffold commit) and the snapshot overlap (footer hints live in screen.tsx, lane c only).

- Grill: phase 1 = act mode + answer/defer; confirm once per session; ink-text-input; no timebox, feat/monitor-v1.
