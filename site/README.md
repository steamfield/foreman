# foreman site

The landing site for foreman, a CLI for delegating coding tasks to Codex from
Claude Code, at https://foreman.steamfield.io.

This directory is a separate Astro project. The landing page replays real foreman
recordings from `fixtures/`; the blog under `/blog` holds
how-to articles for search; `docs/blog/` records how they are planned and sourced. `docs/PRODUCT.md` explains the page and `DESIGN.md` its look.

## Development

Use Bun 1.4.2, Node 26.13.0 and make. Run commands from `site/`:

```sh
make install
make dev
```

Open http://localhost:4321. Set `PORT_WEB` if that port is busy.
`make e2e` runs the Playwright and axe suite against a production build
(Chromium is installed by `make install` outside CI).

## Publishing

```sh
make new-article SLUG=my-first-post TITLE="My first post"
```

Edit `src/content/blog/my-first-post.mdx`. Drafts are visible in dev at
`/blog/my-first-post` and absent from production pages, RSS and sitemap.
Set `status: published` to list a post at `/blog` and in `/blog/rss.xml`;
`unlisted` makes its production URL available without listing it.
The header and footer link the blog. Pages redirects `/blog/` to `/blog`.

## Checks

```sh
make lint
make check
make test
make build
make deploy-check
stacks verify
```

`make build` includes assertions against the generated site and a temporary
published-post build. `make deploy-check` exercises Cloudflare Pages locally.
Use `bunx vitest run src/lib/analytics.test.ts` for one test file, `make coverage`
for coverage, `make format` to format, and `make preview` to view production output.
`make help` lists all targets.

## Analytics and hosting

An empty `PUBLIC_POSTHOG_KEY` ships no analytics or banner code. A keyed build
uses US PostHog and the shared Steamfield consent cookie. Visits stay cookieless
until Accept; recordings and heatmaps require Accept. Both the banner and footer
link the [shared privacy page](https://steamfield.io/privacy).

Cloudflare Pages builds from GitHub: project `foreman`, root `site`, command
`make build`, output `dist`, package manager Bun. Set public build variables in
Pages, including the shared PostHog key when analytics is ready.
See [AGENTS.md](AGENTS.md) for deployment settings, manual upload commands,
toolchain workarounds and pending account setup, and
[development guidance](docs/DEVELOPMENT.md) for content conventions.

## License

Copyright (c) 2026 Riley Hilliard
