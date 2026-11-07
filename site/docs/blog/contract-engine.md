# Contract: SEO blog engine for the foreman site

You are working in a git worktree for an orchestrator who reviews, refactors and commits your work. Leave changes uncommitted and do not push. Ask through `ask_orchestrator` only when blocked by something this contract and the repo don't settle; progress and findings go in the hand-off.

## Goal

Turn the unlinked blog pipeline in `site/` (Astro 7 static, React islands, Tailwind 4, Bun, Node test runner for build tests; production `https://foreman.steamfield.io`) into an SEO-focused blog. Ten how-to articles will be written later as MDX files by separate writers who know only the frontmatter and component API you build here. They target problem queries ("run Codex in a git worktree", "Codex hooks not trusted") from readers who have never heard of foreman. Your job is the engine: schema, index and post pages, post layout, head tags, structured data, OG cards, RSS, sitemap, robots, llms.txt, nav, one demo component, and tests.

What foreman is (for copy you write, e.g. the CTA): `site.description` in `site/src/config.ts`. Install copy comes from the existing landing install data; don't write new install commands.

The bar is the landing page (`site/src/pages/index.astro`). The blog must look like the same site.

## Read first

All paths relative to the worktree root; run site commands from `site/`.

- `site/AGENTS.md`, `site/DESIGN.md`, `site/docs/DEVELOPMENT.md`, `site/docs/PRODUCT.md` in full.
- Root `AGENTS.md` (Conventions, Guardrails) and `.claude/rules/src/typescript.md`, `.claude/rules/src/testing.md` (Codex doesn't load these automatically).
- Existing pipeline: `site/src/content.config.ts`, `site/src/content/schema.ts`, `site/src/lib/posts.ts` (+ test), `site/src/lib/collection.ts`, `site/src/pages/blog/*`, `site/src/layouts/BaseLayout.astro`, `site/src/layouts/PostLayout.astro`, `site/src/components/{PostHeader,PostList,ReadToggle}.tsx` (+ `posts.test.tsx`), `site/scripts/new-article.mjs`, `site/scripts/frontmatter.mjs`, `site/astro.config.mjs`, `site/src/pages/llms.txt.ts`, `site/src/pages/og/index.webp.ts`, `site/src/lib/og.ts`, `site/src/data/commands.ts`, `site/src/components/landing/CommandTabs.tsx`, `site/src/components/landing/InstallPanel.tsx`, `site/src/scripts/site.ts`, `site/src/styles/global.css`.
- Tests: `site/tests/build.test.mjs` (its temporary production build with probe posts around line 160-200), `site/tests/new-article.test.ts`, `site/tests/drift.test.ts`, `site/tests/deploy.test.mjs`, `site/e2e/landing.spec.ts`, `site/vitest.config.ts`, `site/Makefile`.
- Reference implementation (another product's site built from the same scaffold; take patterns, not copy): `/Users/riley/Projects/rr/site/src/layouts/BaseLayout.astro`, `/Users/riley/Projects/rr/site/src/layouts/BlogLayout.astro`, `/Users/riley/Projects/rr/site/src/lib/blog.ts`, `/Users/riley/Projects/rr/site/src/content/blog-schema.ts`, `/Users/riley/Projects/rr/site/src/pages/blog/`, `/Users/riley/Projects/rr/site/src/pages/og/[...slug].webp.ts`, `/Users/riley/Projects/rr/site/tests/build.test.ts` (blog section).

## Skills to apply

```sh
ce=$(ls -d "$HOME"/.claude/plugins/cache/*/ce/*/ | sort -V | tail -1)
```

- `${ce}skills/writing-tests/SKILL.md` for every test.
- `${ce}skills/architecting-systems/SKILL.md` before adding lib modules and components.
- `${ce}skills/handling-errors/SKILL.md` for build-time validation errors (name the post and field).
- `${ce}skills/design/SKILL.md` for index and post layout; match the existing site.
- `/Users/riley/Projects/opendata/.claude/skills/seo/SKILL.md`: titles, descriptions, JSON-LD (no nulls), canonicals, breadcrumbs, robots. Written for another site; take the rules, not its code.

Say in the hand-off where each changed your approach.

## Interface

### Frontmatter (`site/src/content/schema.ts`, extend `postSchema`)

Keep `title`, `description`, `date`, `updated`, `author`, `status` (draft|published|unlisted, default published), `cover`, `ogImage`. Drop `tags` only if nothing uses it; otherwise keep. Add and enforce:

- `title`: 1 to 48 characters (so `title | foreman` is at most 60).
- `headline`: optional, at most 110 characters; the h1 when present, else `title`.
- `description`: 120 to 160 characters.
- `keyword`: required string, the primary query.
- `feature`: enum `delegation | parallel | worktrees | background | questions | review | contracts | hooks | safety`.
- `updated` on or after `date`.
- `author` defaults to `site.author` if that is simple; otherwise keep it required.

Errors name the field and the limit. Because `astro.config.mjs:14` parses every post with this schema at config time, a draft from `make new-article` must still parse: update `scripts/new-article.mjs` to scaffold valid placeholder values (a 120-char placeholder description, `keyword: TODO`-style string, `feature: delegation`) and keep `status: draft`, and update `tests/new-article.test.ts` and existing schema/component fixtures to the new fields.

### Pages and layout

- `/blog` (`src/pages/blog/index.astro`): indexable when at least one published post exists (keep noindex while there are none). Title "Delegating to Codex from Claude Code" (or similar, at most 48 chars). One h1, a one-paragraph lede, posts newest first (headline or title, description, date, reading time). JSON-LD `CollectionPage` (`@id`, url, name, description, `isPartOf` WebSite `@id`, `about` SoftwareApplication `@id`, `mainEntity` `ItemList` of published posts) and `BreadcrumbList` (Home > Blog, last item without `item`).
- `/blog/<slug>` (`trailingSlash: "never"`, file build): rendered by `PostLayout.astro` (extend it; rename only if needed). In order: breadcrumb nav (Home / Blog / title, current `aria-current="page"`), one h1 (`headline ?? title`), description as lede, meta line (`<time datetime>` date, "Updated ..." when set, reading time), a table of contents from H2s (sticky rail at xl, `<details>` "On this page" below xl; only one carries any highlight hook), body in the existing prose styles, then from the layout (never in MDX): an install CTA (one sentence from `site.description`'s first clause or similar, the existing install command and copy behavior so `install_copied` still fires; reuse `InstallPanel` or the shared copy pattern and say which), and "More from the blog" (up to 3 other published posts, same `feature` first, then newest). Remove `ReadToggle` from posts only if it conflicts; say what you did.
- Displayed dates use `timeZone: "UTC"`; `datetime` and JSON-LD use ISO from the same Date.

### Head tags and structured data (`BaseLayout.astro`)

Without changing what existing pages emit except as listed:

- New optional props: `ogType` (`website` default, `article`), `publishedTime`, `modifiedTime` (`article:published_time`, `article:modified_time` = updated ?? date), `jsonLd` (array) rendered as one `<script type="application/ld+json">` with an `@graph`, `<` escaped.
- `og:title` and `twitter:title` equal the full `<title>` text; add `twitter:title`/`twitter:description` if missing; description identical across meta/og/twitter.
- Robots: indexable pages get `max-snippet:-1, max-image-preview:large`; `noindex` pages (unlisted posts, 404, empty blog index) keep `noindex, nofollow` and nothing else.
- Home: `WebSite` (`@id` `https://foreman.steamfield.io/#website`) and `SoftwareApplication` (`@id` `.../#software`, name foreman, description `site.description`, url, `applicationCategory: "DeveloperApplication"`, `operatingSystem: "macOS, Linux"`, `license` MIT URL, `sameAs: [site.repo, site.npm]`, `offers` `{ "@type": "Offer", "price": "0", "priceCurrency": "USD" }`). No ratings.
- Posts: `BlogPosting` (`@id` canonical + `#article`, headline, description, url, `mainEntityOfPage`, `datePublished`, `dateModified`, `image` its OG card URL, `keywords` the keyword, `inLanguage: "en"`, `author` Person Riley Hilliard `https://github.com/rileyhilliard`, `publisher` Organization Steamfield `https://steamfield.io`, `isPartOf` Blog `@id` `/blog#blog`, `about` `{ "@id": ".../#software" }`) and `BreadcrumbList` (Home, Blog, post; last item without `item`).
- No `null` or `undefined` anywhere in JSON-LD; omit keys.

### OG cards

Per published and unlisted post: `/og/blog/<slug>.webp` from the existing `src/lib/og.ts` layout with the post title; `/og/blog.webp` for the index. Posts set `og:image` to their card unless `ogImage` is given.

### Discovery

- Sitemap: the allowlist in `astro.config.mjs` adds `/blog` when published posts exist; published posts only (unlisted and drafts never).
- RSS (`blog/rss.xml.ts`): published only, absolute links, pubDate = date.
- `robots.txt` (new, `public/robots.txt` or a route): `User-agent: *`, `Allow: /`, `Sitemap: https://foreman.steamfield.io/sitemap-index.xml`. Check what the sitemap integration actually writes and use that path; if `/sitemap.xml` 404s, add `public/_redirects` `/sitemap.xml /sitemap-index.xml 301` and assert it in `deploy.test.mjs`.
- `llms.txt`: a `## Blog` section listing each published post as `- [title](absolute url): description`. If loading the collection makes `GET` async, update `tests/drift.test.ts:41` and use the documented Node environment for Astro content APIs (`site/docs/DEVELOPMENT.md`).
- Nav: add `{ label: "Blog", href: "/blog" }` to `site.nav` (header) and a Blog link in the footer nav. The header must not overflow at 375px (nav items are already `hidden sm:inline`; keep that pattern).

Keep three states distinct everywhere: published (index, sitemap, RSS, llms, related, indexable), unlisted (routable, `noindex`, listed nowhere), draft (absent from production).

### Demo component (`site/src/components/blog/CommandDemo.astro`)

One component so writers can show real foreman output without hand-writing it: renders one recorded command from `fixtures/cli/*.json` through `src/data/commands.ts`, framed like the landing `CommandTabs` console, inside `<figure class="not-prose">` with a required `caption` prop and the island content wrapped in `data-nosnippet`. Prop `command` is one of the recording names (`answer | archive | doctor | result | start-wait | status-release | wait-all`), typed from the data; an unknown name throws at build time naming the bad value and the allowed ones. Reuse landing components and data as they are; if a landing component truly needs a change, keep it minimal and say why. Writers import it as `import CommandDemo from "../../components/blog/CommandDemo.astro";`.

## Tests

- Replace the `welcome.mdx` dependency in `tests/build.test.mjs` (~line 181) and `tests/new-article.test.ts` (~line 59) with test-owned fixture posts written into the temporary build root, keeping the existing published/draft/unlisted/nested coverage. Add one test-owned published fixture post with valid new frontmatter, three H2s and a `CommandDemo`, so every per-post assertion runs before any real article exists.
- Replace the "production has an empty blog / sitemap lists only `/`" assertions with: with zero real posts, the production blog index is noindex, RSS is valid and empty, sitemap lists only `/`; with published posts (the fixture build), the rules below.
- Per published post (in the fixture build, and in the real `dist/` for every real published post): exactly one h1; `<title>` at most 60 chars and equal to og:title and twitter:title; description 120-160 chars and identical across the three tags; canonical `https://foreman.steamfield.io/blog/<slug>`; `og:type=article`; ISO `article:*` times; JSON-LD parses, has no null, has `BlogPosting` whose `about.@id` equals the home SoftwareApplication `@id`, and a `BreadcrumbList` whose last item lacks `item`; in sitemap, RSS and llms.txt; OG card exists and is a valid webp; no duplicate `id` attributes; every internal link and `#anchor` resolves to a built page/id; TOC entries point at H2 ids. Index: `CollectionPage` + `ItemList` newest first. Unlisted: noindex, absent from index/sitemap/RSS/llms/related. Draft: absent.
- Unit tests next to new lib code (reading time, related-post selection, JSON-LD builders with no nulls, schema limits with the field named in errors).
- e2e (`site/e2e/`): `/blog` and the first published post found at runtime (skip when none) get the existing axe check and a no-horizontal-scroll check at desktop and 375px, including the header.
- `deploy.test.mjs`: a published post (fixture or real), its canonical variants (with trailing slash, `.html`) and its OG card respond as the existing tests expect for `/`.
- Document in the hand-off and in a comment at the top of the build test a scoped command article writers run instead of full `make build` (for example `bunx astro build && node --test --test-name-pattern=blog tests/build.test.mjs`), which must skip the temporary fixture rebuild.

## Scope

- May change: `site/src/content/`, `site/src/content.config.ts`, `site/src/lib/`, `site/src/pages/`, `site/src/layouts/`, `site/src/components/blog/`, `site/src/components/PostHeader.tsx`, `site/src/components/PostList.tsx`, `site/src/components/ReadToggle.tsx`, `site/src/components/posts.test.tsx`, `site/src/config.ts` (nav only), `site/src/styles/global.css`, `site/src/scripts/site.ts`, `site/scripts/new-article.mjs`, `site/astro.config.mjs`, `site/public/robots.txt`, `site/public/_redirects`, `site/tests/`, `site/e2e/`, `site/package.json` and `site/bun.lock` (only if a dependency is truly needed; say why).
- Must not change: anything outside `site/`; `site/fixtures/`; `site/src/data/` (reuse as is); `site/src/components/landing/` (reuse; minimal change only if unavoidable, explained); `site/AGENTS.md`, `site/README.md`, `site/docs/`, `site/DESIGN.md` (the orchestrator updates docs); `wrangler.jsonc`; analytics modules except reading them.
- Delete `site/src/content/blog/welcome.mdx` once nothing depends on it.

## Acceptance

From `site/`, iterate until all pass:

```sh
make lint
make check
make test
make build
make e2e
make deploy-check
```

Also run once the scoped writer command you documented, against a temporary copy of the fixture post placed in `src/content/blog/` (remove it afterwards), and report its result.

QA as a first-time visitor: `make dev PORT_WEB=4351`, open `/blog`, the fixture post (temporarily in `src/content/blog/`, removed after), and `/` at 1440px and 375px with Playwright (installed). Check the Blog link, breadcrumb, one h1, TOC at both widths, the CommandDemo, CTA, related list, no sideways scroll. Save screenshots to `$TMPDIR/foreman-blog-qa/` and list them with what each shows. Stop the dev server.

## Do not

- commit or push
- disable a lint rule, weaken or skip an existing test, or cast to get green (rewriting the empty-blog assertion as specified above is a planned change)
- add features beyond this contract (no tag pages, pagination, search, comments, newsletter, author pages)
- hand-write foreman output anywhere
- use raw hex or `dark:` variants; token utilities only (`src/styles/tokens.test.ts` must pass)

## Review before hand-off

Once acceptance passes, get one independent review and fix what it finds:

```sh
review="$(mktemp -d)"
body() { awk 'NR==1&&/^---$/{f=1;next} f&&/^---$/{f=0;next} !f' "$1"; }
{
  body "${ce}agents/code-reviewer.md"
  echo
  echo "The base branch is blog; review the uncommitted work in $PWD. Your sandbox is read-only,"
  echo "so don't run the tests; the author ran them. The task's contract:"
  cat "site/docs/blog/contract-engine.md"
} > "$review/prompt.md"
codex exec --ephemeral --sandbox read-only -m gpt-6.1-sol -c 'model_reasoning_effort="high"' \
  -c 'service_tier="priority"' -o "$review/review.md" - < "$review/prompt.md"
```

Fix every finding or say why it's wrong; a bug finding gets a regression test first. Rerun acceptance. One pass.

## Hand-off

Leave everything uncommitted and end with:

1. Summary (2-3 sentences).
2. Files: each created or changed, one line why.
3. Decisions: what the contract left open and what you chose (CTA copy mechanism, TOC, ReadToggle, author default, sitemap path, schema placeholder values), deviations and why.
4. Checks: each command with result and counts; QA screenshots and what each shows.
5. Review: file path, each finding and its resolution.
6. Look closer at: least certain places.
7. For the article writers, ready to paste: the exact frontmatter block with every field, the CommandDemo import line and props, MDX conventions that work here (callouts, code fence titles if supported), and the scoped acceptance command.

## Amendment 1: landing page SEO (added by the orchestrator; part of this task)

Tune the home page's search-facing markup per `/Users/riley/Projects/opendata/.claude/skills/seo/SKILL.md`, alongside the blog work. Today `<title>` is the bare brand "foreman" and every page without its own description reuses `site.description` (~240 chars), which Google truncates.

- Home `<title>`: at most 60 chars, front-loads the primary keyword, brand suffix `| foreman`, matching the h1's intent. The h1 is `hero.title` in `src/data/landing.ts` ("Codex models as subagents for Claude Code."); use something like "Codex subagents for Claude Code | foreman" (choose and justify; don't change the h1 copy). `og:title` and `twitter:title` identical to `<title>`.
- Home meta description: 150 to 160 chars, front-loaded keywords (Claude Code, Codex, subagents, git worktree), plain language, identical across description/og:description/twitter:description. Add it as a new `site.metaDescription` (or similar) in `site/src/config.ts`; keep `site.description` as the long form for the `SoftwareApplication` JSON-LD description, llms.txt and anywhere a drift test pins it.
- Fallback: pages that pass no description (404, empty blog index) use the short meta description, never the long one. Every indexable page must end up 120 to 160 chars.
- Home also gets: robots `max-snippet:-1, max-image-preview:large`, `og:type=website`, `og:site_name`, `og:locale=en_US`, `og:image:alt`, absolute canonical `https://foreman.steamfield.io/` (check what Astro emits with `trailingSlash: "never"` for the root and keep it consistent with the sitemap URL), and the `WebSite` + `SoftwareApplication` JSON-LD already in this contract.
- Heading hierarchy on `/`: exactly one h1, h2 per section, no skipped levels; fix skips you find in `src/pages/index.astro` or landing components with minimal changes (heading level only, no copy or visual change; say what you changed).
- `data-nosnippet` on the replay/console sections (CLI recordings, supervision console) so snippets come from prose, if not already present.
- Tests: extend `tests/build.test.mjs` with home assertions: title <=60 and identical across title/og/twitter, description 150-160 and identical across three tags, canonical, robots, one h1, no skipped heading levels, JSON-LD graph exact shape with no nulls.
- May change additionally: `site/src/config.ts` (new key; nav), `site/src/pages/index.astro` (head props, JSON-LD, heading levels, nosnippet attributes only), `site/src/components/landing/*.tsx` (heading levels and `data-nosnippet` only), `site/src/pages/llms.txt.ts`.
- Report in the hand-off: the final home title and description with character counts, and every heading-level change.
