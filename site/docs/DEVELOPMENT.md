# Developing the blog

`src/config.ts` owns the public site metadata at https://foreman.steamfield.io.
Canonical and Open Graph URLs use explicit routes, so a file
build's `.html` suffix never becomes the canonical URL.

`src/lib/posts.ts` owns publication rules. Index and RSS use published posts;
production routes also include unlisted posts; dev routes include drafts.
`src/lib/collection.ts` alone loads the collection for those consumers. Astro's
collection declaration and route renderer also import `astro:content`.
Tests that load Astro's content APIs use `// @vitest-environment node` because a
browser environment resolves client exports. Keep post selection tests pure.

Sitemap configuration runs before the content layer. It parses YAML frontmatter
with `scripts/frontmatter.mjs` and the same schema, then uses the published-post
selector. An explicit allowlist leaves drafts, unlisted posts, error pages and
image endpoints out. New content routes must join that allowlist.
The collection loader explicitly uses the same filename-based ID rule as the
sitemap: nested `notes/index.mdx` maps to `/blog/notes`, matching Astro's index routing.
The landing page owns `/`; the blog index is `/blog` (Pages redirects `/blog/`
there) and RSS is `/blog/rss.xml`. The sitemap currently lists only `/` because
the welcome post is a draft. The header does not link the blog.

Reusable UI is React; the two layouts and routes are Astro. Only `ReadToggle`
hydrates. Add a colocated Testing Library test for each interactive component.
`make build` checks the real static pages, RSS, sitemap and error page after Astro
builds them. A temporary copy publishes the welcome post to test MDX, metadata,
syntax highlighting and hydration without publishing it on the real site.

`make new-article SLUG=my-post TITLE="My post"` writes a draft without overwriting.
Edit its description before publication. Slugs are lowercase words and hyphens;
keep filenames URL-safe. The command test uses real files and a real process.

Prettier checks the entire project except generated and agent-owned content in
`.prettierignore`. Format new fragment files too. Run `make coverage` for the
same tests with V8 coverage. An empty `PUBLIC_POSTHOG_KEY` keeps analytics inert.
`BaseLayout.astro` gates both analytics and the shared consent banner on that
build-time key; a keyless production build contains neither JavaScript bundle.
The shared `sf-consent` cookie lives on `.steamfield.io`. Until Accept,
PostHog runs cookieless; recordings and heatmaps start only after Accept.
The offline test also checks a shared consent withdrawal while this page is in
the back-forward cache, and prevents remote config from enabling console Logs.
Build assertions use Vite's production env-file precedence, including a keyed
temporary `.env.production` build, just as Astro does.

## Shared UI and theme

`src/styles/global.css` declares Tailwind's layer order with the shared `sf`
layer between base and components. It imports the requested UI stylesheets;
`sf-theme.css` maps their tokens to placeholder site colors. There is one theme,
with readable light prose and GitHub light syntax highlighting. Archivo and
IBM Plex Mono are installed but not imported; page design and fonts come later.

## Optional social images

Replace `public/default-og.svg` with a raster social image before publishing,
and update `site.image` and the build assertion. For generated per-post images,
install the declared `og-images` dependencies, render a flexbox card through
satori and resvg in `src/pages/og/[...slug].png.ts`, load local fonts from
`src/assets/fonts/`, and use the routable production posts (never drafts).
Set each post's `ogImage` to its image route and add a PNG build assertion.
satori accepts TTF, OTF and WOFF fonts, not WOFF2.

## Running servers

Dev and preview use `--ignore-lock` to stay in the foreground under agents.
Stop the owned process with Ctrl+C. For an Astro-managed background instance,
use `bunx astro dev stop` or `bunx astro preview stop`.
Only `PUBLIC_` variables reach browser bundles. Draft visibility always uses
`import.meta.env.DEV`. Delete `.astro/` if generated collection types look stale.
