# Plan: multi-provider landing page, docs route and agy posts

Skill: sprint. Profile: sprint. On resume, re-read shared/lane-dag.md before anything else.
plan_graph: /Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/shared/scripts/plan_graph.py
Started: 1795402071 (2026-11-22). Timebox: none. Landing branch: sprint/multi-provider-docs.
Gate: `cd site && make lint && make check && make test && make build && make e2e` (~50s). Filtered tests: `cd site && bunx vitest run <file>`. Typecheck: `cd site && make check`.
Runner: plain commands.
Worktree setup: `cd site && bun install --frozen-lockfile`.

## Spec

foreman 0.4 added agy (Google's Antigravity CLI, serving Gemini models such as Gemini 4 Neon) as a second provider beside Codex. The landing site at foreman.steamfield.io still presents foreman as Codex-only and has no documentation beyond the GitHub README. This sprint makes the landing page provider-neutral, adds a `/docs` route modeled on ~/Projects/decks (repo-root Markdown guide rendered by the site), and adds three blog posts on running agy/Gemini from Claude Code.

In scope:
- Guide content in repo-root `docs/guide/*.md`, plain Markdown readable on GitHub, no frontmatter. The site derives title, description, group and order.
- `/docs` home with cards per group, `/docs/<id>` pages with a sticky sidebar that nests the current page's h2 outline (scrollspy), prev/next pager, "View as Markdown" and "Copy page", `/docs/<id>.md` exports, `/llms-full.txt`, docs listed in `/llms.txt`, docs in nav, footer and sitemap.
- Landing copy and models section cover both providers; keep the Codex replays, labeled as Codex; add a real captured `foreman models` transcript that shows both catalogs.
- Fix the existing drift-test failures (README gained commands, an exit code and Codex 0.171.0).
- Three new blog posts about agy/Gemini through Claude Code, following `site/docs/blog/contract-article.md`.
- README links to the docs site.
- Merge to main and push to deploy (user asked).

Out of scope: editing the ten existing Codex posts beyond lines that claim foreman is Codex-only; recording a new agy run replay; per-page docs OG cards (docs pages use the site card); docs search; live demos inside docs.
Assumptions: canonical paths have no trailing slash (`/docs/providers`, matching the site's `trailingSlash: "never"`); docs ids are guide filenames, with `README.md` as `overview`; the guide drops the decks "inline code click-to-copy" only if it fights the existing copy buttons (lane b decides and reports).
Error model: build-time only. A guide file without a level-one title, a guide link to a missing page, or an unknown group fails `astro build` with a message naming the file. No runtime errors; Copy page hides itself when the clipboard or fetch is unavailable.

## Contracts (scaffold commit)

- `site/src/config.ts`: `docsGroups` (`getting-started` "Getting started", `guides` "Guides", `reference` "Reference") and a "Docs" nav item to `/docs`.
- `docs/guide/*.md`: one stub per page with its h1 and a one-paragraph summary, so the route builds before content lands.

Layout:

    docs/guide/
      README.md            overview: what foreman is, the terms, where to go next (id overview, group getting-started, order 0)
      getting-started.md   install, sign in to Codex and/or agy, skill install, doctor, first delegation (getting-started, 1)
      repo-setup.md        hook trust for Codex, .agents/hooks.json for agy, AGENTS.md and rules (getting-started, 2)
      providers.md         Codex and agy, model routing, catalogs, defaults, provider differences (guides)
      delegating.md        contracts, start, wait, questions, steer, followup, interrupt, result, review, archive (guides)
      monitor.md           foreman monitor screens and keys (guides)
      how-it-works.md      daemon, supervision, budgets, deferral, storage, recovery, upgrades (guides)
      cli.md               every command, wait outcomes, exit codes (reference)
      configuration.md     config file, environment, state and logs (reference)
    site/src/lib/guide.ts          guide id, derived metadata and link rewriting; pure
    site/src/lib/docs.ts           nav, pager, outline, Markdown export, llms builders; pure
    site/src/content.config.ts     adds the docs collection over ../docs/guide
    site/src/content/schema.ts     adds docSchema
    site/src/pages/docs/           index.astro, [...slug].astro, [...slug].md.ts
    site/src/layouts/DocsLayout.astro
    site/src/components/docs/PageOutline.astro
    site/src/pages/llms-full.txt.ts

## Phases

### Phase 1: docs route (MVP)

Scaffold: c97fa22
Tag: mpd-phase-1
Demo: `cd site && make dev`, open http://localhost:4321/docs, click through every page, check `/docs/providers.md` and `/llms-full.txt`.
Test cases (lane b writes them): guide id mapping (README -> overview); title from h1, description from first paragraph with links and backticks stripped, truncated at 160; missing h1 throws naming the file; group and order per the layout table; nav groups in config order, sorted by order then title, empty groups dropped; pager crosses group boundaries and returns undefined at the ends; guide links `providers.md`, `./cli.md#exit-codes` rewrite to `/docs/providers`, `/docs/cli#exit-codes`, while links inside fenced code stay untouched and external links stay; a guide link to a missing page throws; Markdown export starts `# Title`, `> description`, drops the source h1; llms-full lists pages in sidebar order; outline lists only h2s and labels a code-only h2 with its command name; build output has `docs.html`, one html and one md per page, sitemap lists `/docs` and every page, `/llms.txt` links every `.md`; e2e: sidebar marks the current page, outline links jump to anchors, mobile menu works at 375px with no horizontal overflow, axe passes on `/docs` and one page.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | docs/guide/ | README.md, docs/architecture.md | | opus | merged | sprint/multi-provider-docs-1a | nine guide pages written and checked against the code |
| b | M | site/src/lib/guide.ts, site/src/lib/guide.test.ts, site/src/lib/docs.ts, site/src/lib/docs.test.ts, site/src/content.config.ts, site/src/content/schema.ts, site/src/pages/docs/, site/src/pages/llms-full.txt.ts, site/src/pages/llms.txt.ts, site/src/layouts/DocsLayout.astro, site/src/components/docs/, site/src/styles/global.css, site/src/scripts/site.ts, site/src/scripts/site.test.ts, site/src/layouts/BaseLayout.astro, site/astro.config.mjs, site/tests/build.test.mjs, site/tests/deploy.test.mjs, site/e2e/docs.spec.ts, site/AGENTS.md | ~/Projects/decks/site/src/lib/docs.ts, ~/Projects/decks/site/src/layouts/DocsLayout.astro | | opus | merged | sprint/multi-provider-docs-1b | route builds, its tests pass, gate green except the known drift failures |

#### Lane a brief

- Goal: write the user guide for foreman 0.4.1 as nine Markdown pages in `docs/guide/`, replacing the scaffold stubs. Readers are developers using Claude Code who want to delegate to Codex or agy. The guide is provider-neutral: every page that applies to both providers says so, and provider differences are stated where they matter.
- Interface: plain Markdown, no frontmatter. Each file starts with `# Title`, then one summary paragraph (it becomes the meta description and card text, so 120 to 160 characters reads best, never over 160 after links and backticks are stripped). Use `##` for sections a reader would jump to (they become the sidebar outline) and `###` below that. Link between pages with relative filenames (`[providers](providers.md)`, `cli.md#exit-codes`); the site rewrites them. Link repo files with full GitHub URLs (`https://github.com/steamfield/foreman/blob/main/<path>`), since relative repo paths break on the site.
- Behavior: pages and what each covers are in the plan's Layout block; keep those filenames and h1s close to: "foreman" (README.md, written as the overview), "Getting started", "Repo setup", "Providers and models", "Delegating a task", "Watching runs", "How it works", "Command reference", "Configuration". Sources, in order of authority: the code (`src/`), `foreman <command> --help` and `foreman guide <topic>` output from this checkout (`bun install && bun run dev -- --help`, `bun run dev -- guide`, `bun run dev -- start --help`; running these needs no inference), `README.md`, `docs/architecture.md`. Every flag, default, exit code and state you name must match the code or `--help`. The command reference covers every command in `src/cli.ts`, including `models`, `update` and `monitor`, plus the wait outcomes and exit code tables. Real models today: Codex `gpt-*-sol`, `gpt-*-terra`, `gpt-*-astra` families; agy lists `gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash` and others with effort suffixes (`gemini-4-neon-high`). Refer to families, not versioned Codex names.
- Prose: read and follow `/Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/skills/writer/SKILL.md` (Educator/documentation persona) before writing. Plain, specific, no marketing, no em dashes, sentence-case headings, tables where a reader compares rows, short code blocks with real commands.
- Decisions already made: the README stays as the repo's quick start and keeps its own command reference (a site drift test compares against it); do not edit README.md. The guide may restate README facts in better order.
- Out of scope: editing anything outside `docs/guide/`; inventing features (MCP wrapper, Channels push and launchd are deferred, say so only where a reader would look for them); speed or cost claims.
- Done when: nine pages exist with the filenames above, every relative link resolves to one of them, and you have spot-checked each command and flag against `--help`. Report anything in the README you found to be wrong.

#### Lane b brief

- Goal: add the `/docs` route to the Astro site in `site/`, rendering `../docs/guide/*.md`, with the reading experience of ~/Projects/decks' docs: sticky sidebar grouped by section with the current page's h2 outline nested under it and a scrollspy highlight, a docs home with one card per page grouped by section, a prev/next pager, "View as Markdown" and "Copy page" under each page, a `/docs/<id>.md` export per page, `/llms-full.txt`, and a Docs section in `/llms.txt`. Port decks' implementation (read `~/Projects/decks/site/src/lib/docs.ts`, `lib/guide.ts`, `layouts/DocsLayout.astro`, `components/docs/PageOutline.astro`, `pages/docs/*`, `pages/llms-full.txt.ts`, `content.config.ts`, the `.docs-*`, `.brand-top*` and `.copy-tip` rules in `src/styles/global.css`, and `setupCopyPage`, `setupTocHighlight`, `setupInlineCodeCopy` in `src/scripts/site.ts`), adapted to this site's conventions in `site/AGENTS.md` and `site/DESIGN.md`.
- Interface: `docsGroups` from `src/config.ts` (scaffold). `guide.ts` exports `guideId(file)`, `guideData(id, body)` (title, description, group, order per the plan's Layout block, throwing `Guide <id> needs a level-one title.`), `guideLink(href)` and `guideMarkdown(source)`. `docs.ts` exports `docHref(id)` -> `/docs/<id>`, `markdownHref(id)` -> `/docs/<id>.md`, `docsNav`, `pageLinks`, `toMarkdownExport`, `llmsFull`, `outline`, `commandName`. Pages render through `astro:content`'s `render`. Use `/docs/<id>` with no trailing slash everywhere (site uses `trailingSlash: "never"`, `build.format: "file"`).
- Behavior: the test cases listed under Phase 1, which you write first (`src/lib/guide.test.ts`, `src/lib/docs.test.ts`, additions to `tests/build.test.mjs` and `tests/deploy.test.mjs` if it checks routes, `e2e/docs.spec.ts` mirroring `e2e/blog.spec.ts`'s axe and 375px checks). Link rewriting must apply to the rendered HTML too, not just the `.md` export: do it in a small remark plugin registered in `astro.config.mjs` (walk the mdast yourself; Astro already ships remark) and reuse `guideLink`. No new dependencies: decks uses `satteri` for the export rewrite; here rewrite the export with the same mdast approach via the remark parser Astro already depends on, or a fence-aware scan, your call, tests decide. Guide links to a page that doesn't exist fail the build. Styling uses this site's token utilities (`text-ink`, `text-ink-2`, `border-line`, `bg-page`...), never raw hex; orange (`signal`) only for focus and the current-page marker if DESIGN.md allows it; follow decks' brand-top rule only if DESIGN.md has an equivalent, otherwise use the site's existing card style. Add "Docs" to the footer in `BaseLayout.astro`, add `/docs` and every docs page to the sitemap allowlist in `astro.config.mjs`, add `<link rel="alternate" type="text/markdown">` on docs pages. Update `site/AGENTS.md`'s architecture map with the docs files (one or two lines each).
- Decisions already made: the guide's content is lane a's; the stubs are enough to build and test against. Docs pages use the site's default OG card. The existing Prettier, astro check and Vitest setups apply; Vitest runs on happy-dom.
- Out of scope: docs search, per-page OG images, live demos, editing `docs/guide/`, the landing page and `src/data/landing.ts`, blog posts. Three tests in `tests/drift.test.ts` already fail on main (README drift); leave them, phase 2 fixes them.
- Done when: `cd site && make lint && make check && bunx vitest run src/lib && make build` pass, `make e2e` passes including `e2e/docs.spec.ts`, and the only failures in `make test` are the three known drift tests.

### Phase 2: multi-provider landing page and agy posts

Demo: `cd site && make dev`, read the landing page top to bottom for Codex-only claims, open the three new posts under `/blog`.
Depends on: phase 1
Scaffold: ac2fe32
Scaffold contents: `site/fixtures/cli/models.json` (real `foreman models` from the 0.4.1 build, Codex rows trimmed to the newest of each family after the capture script scrubs versions, columns re-padded) and `"providers"` added to the blog `feature` enum in `site/src/content/schema.ts`.
Test cases: drift tests pass against the current README (commands table incl. `models`/`update`, exit codes, Codex 0.171.0); Models section renders a Codex row group and an agy row group; the `models` CLI fixture renders; no landing string says foreman is Codex-only; each new post passes the build's per-post SEO assertions.

| Lane | Size | Owns files | Reads | Tests | Model | Status | Branch | Done when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | M | site/src/config.ts, site/src/data/, site/src/components/landing/, site/src/pages/index.astro, site/src/lib/og.ts, site/src/pages/og/, site/public/site.webmanifest, site/docs/PRODUCT.md, site/tests/drift.test.ts | README.md, site/docs/PRODUCT.md | | opus | merged | sprint/multi-provider-docs-2a | landing provider-neutral, drift tests green |
| b | M | site/src/content/blog/run-gemini-from-claude-code.mdx, site/src/content/blog/antigravity-cli-with-claude-code.mdx, site/src/content/blog/gemini-neon-subagent-claude-code.mdx, site/docs/blog/briefs/, site/docs/blog/facts.md, site/docs/blog/plan.md | site/docs/blog/contract-article.md, site/docs/blog/facts.md | | opus | merged | sprint/multi-provider-docs-2b | three posts published and passing build SEO checks |

#### Lane 2a brief

- Goal: make the landing page, site metadata and social card describe foreman as Claude Code's delegation tool for Codex and agy (Gemini), and fix the three drift-test failures.
- Interface: copy lives in `src/data/landing.ts` (checked by `tests/drift.test.ts` against the repo README); site metadata in `src/config.ts` is the scaffold's, but its `description` and `metaDescription` strings are yours to rewrite (only those two fields); the models section is `src/components/landing/Models.tsx` with its test; the hero title and page title are in `src/pages/index.astro` and `landing.ts`.
- Behavior: hero title, lede and card name both providers without a feature list; keep the claim that neither needs an API key (README: Codex ChatGPT login, agy Google sign-in; foreman strips OpenAI and Gemini key variables). The models section becomes provider-grouped: Claude Code orchestrator, Codex models (sol, terra, astra with their existing evidence lines), agy models (Gemini 4 Neon, Argon, Hydrogen, 3.8 Flash as the catalog shows; describe what agy is and that agy also lists other vendors' models; no evidence lines since there are no recorded agy runs, and no quality, speed or cost claims about Gemini). Use the captured `site/fixtures/cli/models.json` (in the phase 2 scaffold) where the section shows how a model picks its provider. Keep every Codex replay and label its captions as Codex runs. Rewrite "why", guardrails, agent-facing and install copy to cover both providers, using README's Install and "Add agy" sections (agy optional). Update `commands` and exit codes and the Codex version to match README, so `bunx vitest run tests/drift.test.ts` passes; update the llms.txt command table expectation only if the drift test reads it from `llms.txt.ts` (that file is phase 1's; if it needs edits, report rather than editing). The OG card text (`src/lib/og.ts`) and `public/site.webmanifest` description lose "Codex-only" wording. `docs/PRODUCT.md`: update positioning to two providers.
- Prose: follow `/Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/skills/writer/SKILL.md` and `site/docs/PRODUCT.md`'s voice rules.
- Out of scope: new recordings, new sections, layout redesign, blog posts, docs pages.
- Done when: `cd site && make lint && make check && make test && make build` pass and `make e2e` passes.

#### Lane 2b brief

- Goal: three new published blog posts for people searching how to run Gemini / Antigravity models from Claude Code, each with a brief in `site/docs/blog/briefs/` and new fact-sheet entries in `site/docs/blog/facts.md`.
- Posts (slug, primary query, angle): `run-gemini-from-claude-code` ("run Gemini from Claude Code", pillar: options to hand a task from Claude Code to a Gemini model, what agy is, foreman's agy provider as one option, sign-in without an API key, review before commit); `antigravity-cli-with-claude-code` ("Antigravity CLI with Claude Code", agy specifics: `agy acp`, signing in, hooks in `.agents/hooks.json`, read-only differences vs Codex, question timeout cap); `gemini-neon-subagent-claude-code` ("Gemini Neon subagent Claude Code", choosing a model per task across providers, `foreman models`, `--model gemini-4-neon --effort high`, mixing Codex and Gemini runs in one session with `wait --all`).
- Method: follow `site/docs/blog/contract-article.md` exactly (frontmatter schema, title <= 48, description 120 to 160, one primary query in title/h1/first 100 words/one H2, foreman output only through `CommandDemo` with fixtures from `site/fixtures/cli/`, including the new `models.json`). Every foreman claim cites file:line in facts.md; every agy/Antigravity claim cites an official Google page or `agy --help` output captured on this machine (`agy --help`, `agy acp --help`, `agy models` need no inference); mark unverified claims or drop them. Use `feature: providers` (in the phase 2 scaffold). Link each post to `/docs/providers` and the pillar; link the existing Codex pillar `use-codex-from-claude-code` where relevant. Prose per `/Users/riley/.claude/plugins/cache/claude-essentials/ce/6.0.0/skills/writer/SKILL.md`, Educator persona, no em dashes, no speed or cost claims, no claims about Gemini model quality.
- Out of scope: editing existing posts, schema, components.
- Done when: `cd site && make build` passes its per-post SEO assertions with the three posts published, and `make lint` passes.

## Log

- Scaffold deviation: lane 1b writes its own tests from the case list (site work, tests are mostly build-output assertions), instead of tests committed in the scaffold.
- Known failing before the sprint: 3 tests in site/tests/drift.test.ts (README drift from 0.4.0). Assigned to 2a.
- Plan critique (sonnet): (1) split lane 1b into three: rejected, it is one capability (the docs route) and already dispatched. (2) phase 2 scaffold missing models.json and the feature enum: fixed, both moved to the phase 2 scaffold. (3) link cases for README.md, anchors, mailto, images: sent to lane 1b; deploy reading ../docs/guide: Pages clones the whole repo and decks deploys the same way. (4) fenced `# comment`, BOM: sent to lane 1b; truncation point left mid-word as decks does. (5) unknown or unmapped guide file must fail the build, Copy page hidden without clipboard: sent to lane 1b.
