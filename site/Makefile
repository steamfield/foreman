# foreman development commands.
#
# A starting point: adapt the recipes, but keep the target names.
# `stacks verify` calls install, lint, check, test, build and dev, and CI
# should call the same targets.

PORT_WEB ?= 4321
PORT_E2E ?= 4322
export PORT_WEB PORT_E2E

.DEFAULT_GOAL := help
.PHONY: help install dev lint check test coverage build preview e2e brand new-article format clean deploy-check deploy-preview deploy

help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

install: ## Install dependencies (frozen lockfile when CI is set)
	bun install $(if $(CI),--frozen-lockfile)
	@if [ -z "$(CI)" ] && [ -f lefthook.yml ] && command -v lefthook >/dev/null 2>&1; then lefthook install; fi
	@if [ -z "$(CI)" ]; then bunx --no-install playwright install chromium; fi

# --ignore-lock keeps astro dev in the foreground when it detects an agent
# (otherwise it backgrounds itself and exits). Stop a stray one: bunx astro dev stop
dev: ## Astro dev server on PORT_WEB
	bunx astro dev --port $(PORT_WEB) --ignore-lock

lint: ## Fail if Prettier would change any file
	bunx prettier --check .

check: ## Type-check and validate content (astro check)
	@bun --no-install -e 'require.resolve("@astrojs/check"); require.resolve("typescript")' >/dev/null 2>&1 || { echo 'Missing checker dependencies. Run bun add -d @astrojs/check typescript, then make check.' >&2; exit 1; }
	bunx --no-install astro check

test: ## Unit and component tests
	bunx vitest run

coverage: ## Tests with coverage
	bunx vitest run --coverage

build: ## Static production build into dist/
	bunx astro build
	node --test tests/build.test.mjs

brand: ## Render the WebP icons, lockups, social cards and manifest from public/brand/*.svg
	bun scripts/brand.ts

deploy-check: build ## Check the build through Cloudflare Pages locally
	node --test tests/deploy.test.mjs

deploy-preview: build ## Manual preview (BRANCH, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required)
	@[ -n "$$CLOUDFLARE_API_TOKEN" ] && [ -n "$$CLOUDFLARE_ACCOUNT_ID" ] && [ -n "$$BRANCH" ] || { echo 'Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and BRANCH.' >&2; exit 1; }
	bunx wrangler pages deploy dist --branch "$$BRANCH"

deploy: build ## Manual production deploy (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required)
	@[ -n "$$CLOUDFLARE_API_TOKEN" ] && [ -n "$$CLOUDFLARE_ACCOUNT_ID" ] || { echo 'Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.' >&2; exit 1; }
	bunx wrangler pages deploy dist --branch main

preview: ## Serve the production build
	bunx astro preview --port $(PORT_WEB) --ignore-lock

e2e: ## Browser and accessibility tests against a keyless production build
	PUBLIC_POSTHOG_KEY= $(MAKE) build
	bunx --no-install playwright test

# SLUG and TITLE reach the script as env vars, so titles with quotes are safe.
export SLUG TITLE
new-article: ## Scaffold a draft post: make new-article SLUG=my-post TITLE="My post"
	@[ -n "$$SLUG" ] && [ -n "$$TITLE" ] || { echo 'Usage: make new-article SLUG=my-post TITLE="My post"'; exit 1; }
	bun scripts/new-article.mjs

format: ## Format with Prettier
	bunx prettier --write .

clean: ## Remove build output and Astro caches
	rm -rf dist .astro
