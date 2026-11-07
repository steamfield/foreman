# SEO blog for foreman.steamfield.io

## Context

foreman's landing site (`site/`, Astro 7, static, Cloudflare Pages, `https://foreman.steamfield.io`) has one indexable page. Search engines and AI crawlers have little to learn what foreman is from, and nothing ranks for the problems it solves. Goal: an SEO-focused blog plus 10 articles, built the way rr (`../rr/site`, `../rr/plans/blog/`) and StatGlass (`../statglass/docs-site`) did theirs; they share one template.

Already in `site/`: an unlinked blog pipeline (`src/content.config.ts`, `src/content/schema.ts` with `date`/`status` draft|published|unlisted, `src/pages/blog/index.astro` noindexed while empty, `blog/[...slug].astro`, `blog/rss.xml.ts`, `src/layouts/PostLayout.astro`, `src/lib/posts.ts`, `src/lib/collection.ts`, `scripts/new-article.mjs` via `make new-article`), a sitemap allowlist in `astro.config.mjs`, generated `llms.txt`, one satori OG card (`src/lib/og.ts`), a draft `welcome.mdx`. Missing vs rr/StatGlass: JSON-LD, `og:type`/`article:*`, robots `max-snippet`, per-post OG cards, `robots.txt`, `headline`/`keyword`/`feature` frontmatter with SEO limits, blog in nav/footer, llms.txt Blog section, related posts, TOC, layout CTA, SEO build tests. `site/docs/PRODUCT.md` lists a blog under "Won't" and forbids speed/cost claims.

## Devil's-advocate review (Codex sol, read-only, applied)

The first slate was cut from 10 to 3 survivors. Verified findings that shaped this version: Codex 0.166.0 (foreman's pinned version, `src/codex/protocol.ts:10`) has no `mcp-server` subcommand, and it now ships native worktrees (`codex exec --worktree`), a shared daemon and `codex queue`, so "Codex can't do X" angles were wrong. foreman's `--write` is `dangerFullAccess` with no workspace-write mode (`src/supervisor/turns.ts:48`). Deferral is a prompt instruction, not an enforced safe default (`src/supervisor/prompts.ts`). Stripping API-key env vars (`src/codex/environment.ts:7`) does not prove ChatGPT-only auth. "Use X together" duplicated "use X from"; app-server, exec flags, sandbox modes and login-vs-API-key were docs-intent topics whose readers don't become foreman users. Engine findings (dependency setup at both roots, `welcome.mdx` used as a test fixture, generator migration, draft-only fixture testing nothing, publication states, Node test runner, `make deploy-check`) are folded into Wave 1 below.

## Method

- One primary query and one reader task per article. Answer with what the reader already has first (Claude Code, Codex CLI, git), then foreman where those stop, as one option, plainly. Native Codex features are acknowledged, not denied.
- Inverted Pyramid, `ce:writer` Educator persona, length follows the task (900 to 1,800 words, no padding), H2s as follow-up search questions, query in title/h1/first 100 words/one H2, sentence-case headings, no em dashes, CTA from the layout.
- Shared fact sheet first (Wave 0). Every foreman claim cites file:line; every Codex/Claude Code claim cites an official doc URL or a `--help` capture from the installed version, marked built-in / configurable / not verified. No numbers except measured ones; no speed or cost claims; foreman output only from real captures.
- Each brief records the SERP evidence behind its query (WebSearch, 2026-11-06; no volume data, same limit rr had).

## The 10 articles

| #   | slug                                  | primary query                         | reader task and angle                                                                                                                                                                                                            |
| --- | ------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | use-codex-from-claude-code            | use Codex from Claude Code            | Pillar. Options (shell out to `codex exec`, OpenAI's Claude Code plugin, foreman), what each does about long runs, questions, isolation and review. Prereqs incl. verified auth facts. Absorbs "Claude Code and Codex together". |
| 2   | run-multiple-codex-agents             | run multiple Codex agents in parallel | Independent contracts off one commit, one worktree each, background waits, questions across runs, merge order; foreman `wait --all`.                                                                                             |
| 3   | run-codex-in-git-worktree             | run Codex in a git worktree           | `git worktree add` and native `codex exec --worktree` first; dependency setup, cleanup, never losing unmerged work; foreman managed worktrees and `archive` refusals.                                                            |
| 4   | run-codex-in-background               | run Codex in background               | Native options (exec, daemon, `queue`, resume) first; then process lifetime, progress inspection, steering, budgets, completion handling; foreman's daemon-owned turns.                                                          |
| 5   | codex-waiting-for-input               | Codex waiting for input               | Clarifying question vs approval prompt vs stuck command; foreman `ask_orchestrator`, timeout deferral, late `answer`. Says plainly the deferral is guidance to the model.                                                        |
| 6   | review-codex-changes-with-claude-code | review Codex changes with Claude Code | Find the checkout, inspect tracked and new files, scope vs contract, run the gate, request a follow-up, commit after review; `foreman result` digest.                                                                            |
| 7   | how-to-give-codex-a-coding-task       | how to give Codex a coding task       | Worked brief: goal, allowed files, acceptance checks, open decisions, hand-off format; AGENTS.md (persistent) vs per-task contract; `foreman guide contract`.                                                                    |
| 8   | codex-hooks-not-trusted               | Codex hooks not trusted               | Troubleshoot project trust, `/hooks`, hash-based re-review after edits, linked worktrees; foreman refusing untrusted hooks (`src/core/preflight/hooks.ts:43`).                                                                   |
| 9   | codex-plugin-for-claude-code          | Codex plugin for Claude Code          | Verified install and use of OpenAI's plugin, when it is enough, when a persistent supervised workflow fits. No manufactured deficiencies. Writer must verify the official repo; if it can't, the brief falls back to the spare.  |
| 10  | does-git-worktree-sandbox-codex       | does a git worktree sandbox Codex     | What a worktree separates (files, branch) and what it shares (host, network, credentials, ports); Codex sandbox modes; foreman's read-only default and full-access `--write`, stated up front.                                   |

Spare: `codex-app-server-json-rpc` (engineering post on building foreman's client, `src/codex/client.ts`), for a later batch.

Cannibalization guard: #1 owns the broad integration intent; #2 owns multi-run supervision, #3 the single checkout, #4 process lifetime. Each mentions neighbors in one line and links them.

Internal links: every post links `/` and `/#install`; after all ten land I add sibling cross-links (pillar links all nine; each other post links #1 plus one or two neighbors).

## Where planning files live

`site/docs/blog/`: `plan.md` (this plan, trimmed), `facts.md`, `contract-engine.md`, `contract-article.md`, `briefs/<slug>.md`. Committed with the blog so future posts reuse the method.

## Wave 0: fact sheet (one Codex sol run)

`foreman start blog-facts --new-worktree --from blog --setup "bun install --frozen-lockfile && cd site && bun install --frozen-lockfile" --write --model gpt-6.1-sol`. May change: `site/docs/blog/facts.md` only. Builds the versioned sheet: foreman facts with file:line; Codex 0.166 facts from `--help` captures and official docs (developers.openai.com/codex: hooks, app-server, CLI reference, auth), OpenAI's Claude Code plugin (repo, install, commands), Claude Code facts from code.claude.com docs; each tagged built-in / configurable / not verified. I spot-check it and write the ten briefs from it.

## Wave 1: blog engine (one Codex sol run)

Branch `blog` off `main`. `foreman start blog-engine --new-worktree --from blog --setup "<both-roots install>" --write --model gpt-6.1-sol --contract <scratch>/contract-engine.md`. Contract adapted from rr's `contract-engine.md` to `site/` conventions (`trailingSlash: "never"`, file build, `site/AGENTS.md`, `site/DESIGN.md`, `site/docs/DEVELOPMENT.md`, token utilities, `frontend-design-slop` skill, SEO skill `/Users/riley/Projects/opendata/.claude/skills/seo/SKILL.md`). Scope:

- Schema: add `headline` (<=110), `keyword`, `feature` enum (delegation, parallel, worktrees, background, questions, review, contracts, hooks, safety), title <=48 so `title | foreman` <=60, description 120 to 160; keep `date`, `updated`, `status`. Decide in the contract: drafts get valid placeholder values from `scripts/new-article.mjs` so config-time parsing in `astro.config.mjs:14` never breaks; migrate the generator, its test and existing schema/component fixtures.
- `BaseLayout.astro`: `ogType`, `article:published_time`/`modified_time`, robots `max-snippet:-1, max-image-preview:large` except where `noindex` (unlisted, 404), `jsonLd` prop rendered as one `@graph`.
- JSON-LD: home `WebSite` + `SoftwareApplication` (`@id` `/#software`, free Offer, macOS/Linux); posts `BlogPosting` (`about` `/#software`, author Person Riley Hilliard, publisher Organization Steamfield) + `BreadcrumbList`; index `CollectionPage` + `ItemList`. No nulls.
- Per-post OG cards via `src/lib/og.ts` at `/og/blog/<slug>.webp`.
- Post layout: TOC from H2s, install CTA, "More from the blog" (same `feature` first, published posts only), reading time.
- Discovery keeps three states: published in index, sitemap (add `/blog` to the allowlist when posts exist), RSS, llms.txt, related; unlisted routable, `noindex`, listed nowhere; draft absent. `robots.txt` (allow all, sitemap line). llms.txt Blog section (make `GET` async and update `tests/drift.test.ts:41`). Blog in nav and footer.
- Tests: replace `welcome.mdx` dependencies in `tests/build.test.mjs:181` and `tests/new-article.test.ts:59` with test-owned fixtures; a test-owned published fixture post in the temporary build so per-post SEO assertions run before any article exists (one h1, title/description limits identical across og/twitter, canonical, JSON-LD shape, sitemap/RSS/llms, links and anchors resolve, OG card); unlisted/draft distinctions; e2e axe + 375px overflow on `/blog` and a runtime-selected post; extend `make deploy-check` to a post, its canonical variants and its OG card. Deliver a documented scoped Node test command for article writers (no temporary rebuild).
- Delete `welcome.mdx`.
- Landing page SEO (added at Riley's request, steered into the running engine turn): keyword-first home `<title>` <=60 with `| foreman`, new 150-160 char `site.metaDescription` used for meta/og/twitter and as the fallback (long `site.description` stays for JSON-LD and llms.txt), robots/og completeness, one h1 and no skipped heading levels, `data-nosnippet` on replays, build-test assertions for all of it.

After merging into `blog` I update `site/AGENTS.md`, `site/docs/PRODUCT.md` ("Won't" list), `site/README.md`.

## Wave 2: ten articles (ten Codex sol runs in parallel)

Before dispatch: one managed start verified with the both-roots setup (Wave 0 covers this). Each run: `foreman start article-<slug> --new-worktree --from blog --setup "<both-roots install>" --write --model gpt-6.1-sol --contract <scratch>/contracts/<slug>.md`, supervised with `foreman wait --all` in the background. Contract = `contract-article.md` (rr's adapted) + brief (query, secondary queries, intent, SERP notes, angle, H2 outline, facts from `facts.md`, official URLs). Writers read `ce:writer` SKILL.md + `references/educator.md` + `references/forbidden-patterns.md`, `ce:structuring-articles` + `references/inverted-pyramid.md`, and the SEO skill. May change: exactly `site/src/content/blog/<slug>.mdx`. Acceptance: lint, typecheck, one scoped build + the scoped Node test command; QA on dev port 4361-4370. New claims beyond `facts.md` need a cited source in the hand-off or get cut.

## Review and ship

Per article: hand-off, diff scope, fact check against `facts.md` and cited lines, forbidden-patterns pass, keyword placement, links. Then sibling cross-links, desktop and 375px screenshots of the index and two posts, `make lint check test build e2e deploy-check` in `site/` and root `bun run check`. Conventional Commits on `blog`, then a local merge to `main`. Pushing waits for your go-ahead (Pages isn't connected yet per `site/AGENTS.md`, so a push won't deploy until it is). Archive every foreman run and remove worktrees.

## foreman friction seen while running this

`foreman start --new-worktree` without `--setup` creates the worktree, then refuses it with `WorktreeInvalid` (package.json needs node_modules). The message suggests installing in the worktree or `--skip-deps-check`, not `--setup`, which is the fix for a managed worktree; a read-only review never needs deps. It also checks only the root, so a nested app like `site/` needs both installs. Goes in the friction backlog: name `--setup` in the refusal, consider skipping the deps check for read-only runs.

Supervising ten runs with `wait --all` meant copying a cursor of about 2,000 characters from each result into the next command, and the guard hook rightly refuses an `eval` of the printed `next:` line. The workaround was waiting on the still-active runs by name, which needs no cursor. Candidates: a `wait --all --until-idle` (return once every run in the group is inactive, listing each outcome), or a short cursor id stored by the daemon.

## Verification

- `site/`: `make check test build e2e deploy-check` green; the build test enforces every SEO rule per published post.
- Manual: view-source of one post (title, description, canonical, robots, JSON-LD); `dist/` sitemap, `/blog/rss.xml`, `/llms.txt`, `/robots.txt`.
- After launch: Rich Results Test on two posts, submit the sitemap in Search Console, then judge topics by indexed pages, impressions, clicks and install-copy events (a proxy for installs) and pick the next batch from that.
