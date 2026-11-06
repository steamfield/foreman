# forman landing page: product spec

> Status: built. Kept beside the site so the reasoning behind the page ships with it.

## TL;DR

A one-page site for developers who use Claude Code and also pay for a ChatGPT plan with Codex. Using real forman recordings, it shows Claude handing a written contract to Codex, Codex working in its own worktree, Claude answering a question Codex asked mid-turn, and Claude reviewing the result before anything is committed. Then it gives one install command and the one-time setup, honestly.

## Problem

- Who: a developer who already works in Claude Code and has Codex through a ChatGPT plan. They want Codex's capacity on implementation work Claude can specify, without becoming the message bus between two terminals. Secondary reader: Claude itself, reading the page or `llms.txt` while it sets forman up.
- What: running both agents by hand means copying a spec into Codex, watching it, answering its questions when you happen to look, and pasting its results back for review. A question Codex asks while you're away stalls the work. Nothing checks that Codex stayed inside the files you meant.
- Evidence: forman's own release was built this way. Four delegates fixed forman's release blockers in parallel from one commit (fix-cli, fix-daemon, fix-supervisor, fix-worktrees, 24 to 70 minutes each). One of them asked a scope question that Claude answered 19 seconds later; another question timed out after 15 minutes and forman told Codex to proceed and note it. There is no visitor data yet.
- Why now: v0.1.0 is about to be published to npm as `@steamfield/forman`, and the README is the only explanation. It is accurate and 240 lines long.

## Job to be done

When I have implementation work I can describe precisely, I want Claude Code to hand it to Codex and keep supervising it, so I get a second agent's throughput without watching two terminals or losing review.

- Functional: understand the loop (contract, worktree, wait, answer, review, commit, archive), confirm my setup qualifies (Codex CLI 0.166.0 signed in, git, Node 26 or Bun), and copy an install command.
- Emotional: "Claude stays in charge. Nothing lands that Claude didn't review."

## Journey

| Moment                          | What happens                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry                           | The GitHub repo header, the npm page, steamfield.io, posts about Claude Code and Codex.                                                                                                   |
| First impression (one viewport) | An H1 that states the job, a lede naming both agents and the ChatGPT login, the npm install line with a copy button, and the top of the supervision console already replaying a real run. |
| Core action                     | Copy the install command.                                                                                                                                                                 |
| Feedback                        | A "Copied" state, then the one-time repo setup directly below in Install.                                                                                                                 |
| Recovery                        | Without JS every replay is a static transcript and copy buttons are hidden; commands stay selectable.                                                                                     |
| Return                          | GitHub README for the full reference, `llms.txt`.                                                                                                                                         |

## Experience qualities

Transparent (you read exactly what forman prints), Calm (Claude is in control; the page never hypes autonomy), Dense (it assumes you know Claude Code and git worktrees). The tradeoff is density over teaching: the page doesn't explain worktrees or Codex.

## Page outline

Each section answers one visitor question.

1. Hero: "What is it?" H1: Codex models as subagents for Claude Code. Lede: Claude plans and reviews while forman starts Codex in its own git worktree, tells Claude when it finishes or asks something, and lets Claude answer, steer or interrupt mid-turn, using the Codex CLI's ChatGPT login (no API key). Install line, Install and GitHub links. The supervision console: on the left a Claude Code session delegating with `forman start ... --wait`, on the right the delegate's live event feed and run header, replaying the real fix-supervisor run, time-compressed, including its real question and answer. Claude's prose is written for the page and labeled; forman output and Codex events are real.
2. "Why would I need this?" Before and after: you as the go-between versus Claude holding the other terminal.
   2a. "Which model does what?" Claude Code plans, architects, orchestrates and reviews; Codex models take the work as subagents: sol as the everyday implementer (forman's default), terra as the cheapest model for tests, classification and mechanical edits, astra for visual design. Each card names the part of this page that model built. A closing paragraph says what makes the delegates good: the repo's `AGENTS.md`, rules, shared hooks and an independent review per contract. The page states quality and cost relative to Claude's models only in general terms, since there is no benchmark behind them.
3. "How does a delegation run?" The run lifecycle as an interactive state diagram: start (worktree and setup), running, waiting on a question, and the four ends (done, failed, interrupted, lost), then review, commit and archive. Selecting a state shows what `wait` prints and what Claude does next.
4. "What does Claude hand over?" A real contract excerpt beside the real digest. The digest lists files written and flags `outside May change`, so Claude sees scope drift before reviewing.
5. "What if Codex gets stuck?" The two real questions from fix-supervisor on a timeline: q1 answered in 19 seconds with a different policy than Codex proposed, q2 asked after a repo hook blocked a write and auto-answered after the 15-minute timeout.
6. "Can I run several?" The four parallel release-fix runs as a timeline from one base commit, with duration, commands and files written, and `forman wait --all` as the one command that watches them.
7. "What will Claude type?" Command tabs with real captured output: `start --wait`, `wait`, `answer`, `status`, `result`, `archive`, `doctor`.
8. "What keeps it safe?" The guardrails as a table: read-only unless `--write`, one worktree per run, repo hook trust checked before start, never commits or merges, archive refuses to delete unmerged work, ChatGPT login only with API key variables stripped, turn budget and question timeout.
9. "Can an agent drive it?" `--json` on every command, the `next:` line and its cursor, the exit code table.
10. Install: npm, bun, npx and source tabs; requirements; the one-time repo setup (trust the project in Codex, approve hooks, `forman doctor`) with real doctor output.
11. Footer: GitHub, npm, MIT, "a Steamfield project", privacy.

## Scope

Must (v1)

- Sections 1 to 11. Islands: the supervision console, the lifecycle diagram, command tabs, install tabs.
- Every forman transcript comes from a real recording under `fixtures/`, scrubbed of home paths. Claude's side of a conversation is labeled as written for the page.
- Works without JS, respects reduced motion, demos are keyboard-operable.
- `llms.txt`, social card, sitemap, canonical URLs.
- PostHog events: `install_copied {method}`, `section_viewed {id}`, `command_tab {name}`, `demo_replayed {id}`.

Should

- A browser and accessibility test pass (axe) at desktop and phone widths.
- A drift test that checks the page's commands and exit codes against the README.

Won't (this version)

- Docs pages. The README is the reference; the page links it.
- A blog. The stack's blog pipeline stays, unlinked, with no published posts.
- A light/dark toggle. One theme.
- Claims about speed or cost savings. There's no measurement to back them.

## Success criteria

The first two weeks set the baseline; targets are starting guesses.

| Metric            | Starting target                              | Measurement                    |
| ----------------- | -------------------------------------------- | ------------------------------ |
| Install copy rate | 8% of sessions                               | `install_copied` / sessions    |
| Reach of Install  | 35% of sessions                              | `section_viewed{id:"install"}` |
| Page weight       | 150 KB JS on home, LCP under 1.5s on fast 4G | Lighthouse on `make preview`   |
| Copy accuracy     | 0 mismatches with the README                 | Drift test                     |

## Assumptions and risks

| Assumption                                                        | Confidence | Validation                     |
| ----------------------------------------------------------------- | ---------- | ------------------------------ |
| Visitors already use Claude Code, so the page doesn't explain it  | High       | Referrers                      |
| The real question exchange is more persuasive than a feature list | Med        | Section reach for `#questions` |

| Risk                                             | Mitigation                                                    |
| ------------------------------------------------ | ------------------------------------------------------------- |
| The npm package isn't published at launch        | Launch only after `npm view @steamfield/forman` resolves      |
| Page copy drifts from the CLI                    | Recordings, plus the drift test                               |
| The page reads as an OpenAI or Anthropic product | Name both plainly as third parties; no logos, no brand colors |

## Changes made while building

- A tenth section, "How a session runs", was added after review: an animated simulation of Claude running three delegates on different models (astra for the hero console's design, sol for the command tabs, terra for the browser tests), with a held question, an answer, a steer, a follow-up and archives. Its question and answer text and each lane's commands come from the recordings of the delegates that built this page.
- The contract section shows the `site-console` run instead of fix-supervisor. fix-supervisor's digest flags two test files as outside scope only because its contract listed them with globs, which forman's scope check matches as literal paths.
- The questions section kept fix-supervisor's two questions; the `answer` and `wait --all` command tabs are recordings from this site's own build.
- Section titles are plain nouns ("Run states", "Commands", "Safeguards") after a writing pass.
