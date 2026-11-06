# forman site

## Overview

This separate Astro project serves forman's landing page at https://forman.steamfield.io.
It is one page whose demos replay real forman recordings, plus the stack's MDX blog
pipeline under `/blog` (no published posts). Why the page is shaped this way:
[docs/PRODUCT.md](docs/PRODUCT.md); the visual contract: [DESIGN.md](DESIGN.md).
Use this directory's Makefile and Bun dependencies, independently of the CLI above it.

## Commands

Run from `site/`. Bun 1.4.2 is recorded in `packageManager`, Node 26.13.0 in `.node-version`.

| Command                                         | What it does                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `make help`                                     | List targets                                                               |
| `make install`                                  | Install dependencies; freeze the lockfile in CI                            |
| `make dev`                                      | Foreground dev server on `PORT_WEB` (default 4321)                         |
| `make lint`                                     | Prettier checks                                                            |
| `make format`                                   | Prettier writes                                                            |
| `make check`                                    | Astro strict type and content checks                                       |
| `make test`                                     | Vitest unit and component suite                                            |
| `make e2e`                                      | Build and run Chromium browser and accessibility tests on `PORT_E2E`       |
| `bunx vitest run src/lib/analytics.test.ts`     | Run one test file                                                          |
| `make coverage`                                 | Vitest with V8 coverage                                                    |
| `make build`                                    | Static build plus Node build assertions                                    |
| `make preview`                                  | Foreground production preview on `PORT_WEB`                                |
| `make new-article SLUG=my-post TITLE="My post"` | Create a draft, refusing overwrites                                        |
| `make clean`                                    | Remove `dist/` and `.astro/`                                               |
| `make deploy-check`                             | Build and test Cloudflare Pages locally, no account needed                 |
| `make deploy-preview BRANCH=my-branch`          | Manual upload; requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| `make deploy`                                   | Manual upload to `main`; requires the same credentials                     |
| `stacks verify`                                 | Run the recorded scaffold checks and dev-server probe                      |

Stop owned dev/preview processes with Ctrl+C. `PORT_WEB=<free port>` overrides the port.
The deploy commands are optional manual uploads; normal deployment uses git integration.
Never deploy as part of verification.

## Architecture map

```text
src/pages/index.astro    the landing page: section order and which island goes where
src/data/landing.ts      all landing copy and reference tables (checked by tests/drift.test.ts)
src/data/runs.ts         typed access to the recorded runs in fixtures/runs/
src/data/*.ts            pure build-time shaping per section: supervision (hero replay),
                         session (orchestration diagram), lifecycle, evidence, commands
src/components/landing/  primitives.tsx (Section, DataTable, CodeFrame, StateBadge) and
                         one component per section; console/ and session/ hold subparts
src/components/Logo.astro the mark and "foreman" lockup, inlined from public/brand/
public/brand/            brand pack sources (icon tile, light and dark marks, horizontal and
                         stacked lockups); `make brand` (scripts/brand.ts) renders their WebP
                         sizes, the social cards and public/site.webmanifest.
                         public/favicon.svg is a copy of foreman-icon.svg
src/lib/og.ts            the satori social card; src/pages/og/index.webp.ts serves it
design/logos/            the logo exploration and its preview.html (not shipped)
src/lib/                 format.ts (forman's elapsed and token formats), analytics, events,
                         blog publication rules
src/scripts/site.ts      copy buttons, section_viewed tracking, scroll reveals
src/styles/              global.css (tokens, DESIGN.md), sf-theme.css (--sf-* mapping)
src/pages/blog/, src/content/  the stack's blog pipeline, unlinked
fixtures/runs/           scrubbed forman run records (events, questions, contract, digest)
fixtures/cli/            scrubbed CLI transcripts: { command, output, exitCode }
scripts/capture-*.mjs    write the fixtures from ~/.forman; review output before committing
tests/                   build, deploy, drift and llms.txt assertions
e2e/                     Playwright and axe against the production build
.stacks/                 recorded verification manifest (do not edit)
```

Routes and RSS load the collection through `src/lib/collection.ts` and publication
rules in `posts.ts`. Sitemap config reads YAML through the same schema before
Astro's content layer exists. Canonical paths omit trailing slashes; build output
uses files. `/blog/` redirects to `/blog` on Pages.

### Recordings

Demos replay recordings; never hand-write forman output or Codex events. Capture a run
with `node scripts/capture-runs.mjs <name>` (or `<name>:<transcript>` to take the digest
from a saved `start --wait` transcript, which also works for archived runs) and CLI output
with `node scripts/capture-cli.mjs <name> -- forman <args>`. Both scrub home paths, the
username, temp directories and the paths inside wait cursors. Capture a run's digest before
committing its worktree: the digest's scope check reads the worktree's uncommitted files.
Prose written for the page beside recorded output is labeled as written for the page.

## Agent harness

`CLAUDE.md` imports this file. `.claude/settings.json` wires the session summary,
destructive-command and secret guards, lint-on-write and session-file formatting.
See [the hook reference](.claude/README.md). This site adds no path-scoped rules
or skills. Formatter checks use Prettier, with no separate code linter.
Parent repository trust and hook approval are already done.

## Conventions

- Keep metadata in `src/config.ts` and publication decisions in `src/lib/posts.ts`.
- Drafts render at `/blog/<slug>` in dev only; unlisted posts render in production
  but stay out of listings, RSS and sitemap. The shipped welcome post remains draft.
- Reusable components are React; Astro owns layouts and routes. Hydrate only
  interactive islands. Keep the post prose and single light syntax theme readable.
- `@steamfield/ui` is restricted to `~0.4.0`; React peers are installed, Markdown
  peers are not added directly. Tailwind layer order starts `theme, base, sf,
components, utilities`. `sf-theme.css` maps the site's tokens onto `--sf-*`.
- Style with the token utilities from `global.css`, never raw hex; orange (`signal`) only
  marks attention (a pending question, `waiting`, the primary action, focus). New values go
  in DESIGN.md first and must pass `src/styles/tokens.test.ts`.
- Every island server-renders its final state (no JS, reduced motion) and is gated to
  on-screen playback with `@steamfield/ui/playback`.
- Keep changes inside the requested scope. Do not edit generated `.astro/` or `dist/`.

## Testing

Vitest runs pure publication rules, real YAML/schema checks, Testing Library
components, the real draft-generator process and real PostHog offline. Happy DOM
blocks external scripts; the PostHog boundary observes and drops outgoing events.
`make build` checks production output and builds a temporary copy with published,
draft and unlisted posts to keep the full publishing pipeline covered.
`make deploy-check` launches and stops Wrangler's local Pages runtime and checks
headers, cache behavior, canonical redirects, feeds and 404s. No service runs first.
Run each changed test file three times alone, then `make test`.
`make install` installs Chromium outside CI; CI must run `bunx playwright install chromium`.

## Error handling

Content/schema and tooling failures fail the command. Analytics is optional:
SDK load or initialization failures warn once at the handling boundary, drop
queued calls and leave tracking off. Never silently swallow unexpected errors.

## Analytics

Only `src/lib/analytics.ts` imports `posthog-js`. The module script in
`BaseLayout.astro` passes `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST` and the
shared consent store. Empty key means no analytics or banner JavaScript in the
build; empty host uses US cloud (`https://us.i.posthog.com`).

`createConsentStore({ domain: "steamfield.io" })` and `mountConsentBanner` from
`@steamfield/ui/consent` share one `sf-consent` cookie across the family of sites.
The shared Steamfield PostHog project receives `site: "forman"` on every event
through `before_send`, including opt-in and pageview events. Consent uses
`cookieless_mode: "on_reject"`: pending or declined means no PostHog persistence;
Accept enables cookies, session recording and heatmaps. Withdrawal removes
PostHog persistence and stops those features. Autocapture is off; recordings
mask all inputs and `[data-ph-mask]` text, and omit network headers and bodies.
Back-forward-cache restores recheck the shared PostHog consent cookie, and
restricted events use its current state. Remote console capture is disabled
because PostHog Logs bypasses `before_send`.
Banner and footer link https://steamfield.io/privacy.

The catalog in `src/lib/events.ts` declares `install_copied {method}`,
`section_viewed {id}`, `command_tab {name}` and `demo_replayed {id}`. Islands
call the typed `track()` later. Keep flat scalar snake_case properties; never
send typed free text, emails or tokens. Queued calls are capped at 50.

## Deploy

Cloudflare Pages project: `forman`, git integration mode, production branch `main`.
Set root directory `site`, build command `make build`, output `dist`, and Bun as
the package manager. Set `BUN_VERSION=1.4.2` and `NODE_VERSION=26.13.0` in Pages.
Production follows `main`; enable branch previews in the Pages dashboard.
There is no GitHub deployment workflow. Set `PUBLIC_POSTHOG_KEY` and optional
`PUBLIC_POSTHOG_HOST` as Pages build environment variables for each environment.
Static output has no runtime environment variables or Functions.

`public/_headers` sets security headers and immutable caching for hashed assets;
HTML, feeds and sitemap retain Pages' revalidating cache. Add `public/_redirects`
only for moved content, never for trailing slashes or `.html` canonicalization.

## Build workarounds

- TypeScript stays on 6.x while `@astrojs/check` and Volar exclude 7; remove the
  restriction once their supported peer ranges include 7.
- `@emnapi/runtime` is an explicit dev dependency at the current stable release
  to match `@astrojs/astro2tsx`'s `@emnapi/core` 1.x. Its broad transitive peer
  range otherwise resolved an incompatible 2.x beta locally. Remove when the
  toolchain resolves matching runtime/core versions without it.
- PostHog 1.447 leaves tab identity keys in sessionStorage on withdrawal;
  `applyConsent` clears them. Remove when the real-SDK withdrawal test passes
  without that cleanup.
- PostHog's internal `__extensionClasses` override disables Logs because its
  remote console-capture setting has no client opt-out. Replace it when the SDK
  provides a public disable switch; keep the remote-config regression passing.

## Deferred

Landing page design, final tokens, font imports and event callers. Generated per-post Open Graph images are off.

## Pending user actions

- Connect the GitHub repository to the `forman` Pages project with the settings
  above and attach `forman.steamfield.io`; confirm a preview and production deploy.
- Set the shared Steamfield PostHog project key in Pages build environments and
  enable cookieless tracking in that project's settings.
- For optional manual uploads, provide a Pages-edit API token scoped to the
  account and its account ID in the command's environment.

## Deeper context

See [README](README.md), [development guidance](docs/DEVELOPMENT.md) and
[the hook reference](.claude/README.md).
