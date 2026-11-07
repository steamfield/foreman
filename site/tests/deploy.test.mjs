// Serves the built dist/ through `wrangler pages dev`, Cloudflare's local Pages
// runtime, reading wrangler.jsonc the way a deploy does. Needs no account.
// Run after `astro build` (make deploy-check).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixtureSite } from "./blog-fixture.mjs";
import { after, before, test } from "node:test";

let fixtureRoot = "";
let base = "";
let child;
let state = "";
let output = "";

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

before(async () => {
  fixtureRoot = buildFixtureSite();
  const port = await freePort();
  state = mkdtempSync(join(tmpdir(), "pages-dev-"));
  child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "pages",
      "dev",
      join(fixtureRoot, "dist"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      state,
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", BROWSER: "none" },
    },
  );
  const keep = (data) => {
    output = (output + data.toString()).slice(-16_000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      assert.fail(`wrangler pages dev exited:\n${output}`);
    }
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(1_000) })).ok) break;
    } catch {}
    if (Date.now() > deadline) {
      assert.fail(`wrangler pages dev never answered:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

after(async () => {
  if (child?.exitCode === null && child.pid !== undefined) {
    const closed = once(child, "close");
    process.kill(-child.pid, "SIGTERM");
    const force = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 5_000);
    await closed;
    clearTimeout(force);
  }
  if (state) rmSync(state, { recursive: true, force: true });
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

const get = (path) => fetch(new URL(path, base), { redirect: "manual" });

test("hashed assets are cached for a year as immutable", async () => {
  const isCss = (name) => name.endsWith(".css");
  const asset = readdirSync(join(fixtureRoot, "dist/_astro")).find(isCss);
  assert.ok(asset, "astro build emitted no CSS under dist/_astro");
  const response = await get(`/_astro/${asset}`);
  assert.equal(response.status, 200);
  const immutable = "public, max-age=31536000, immutable";
  assert.equal(response.headers.get("cache-control"), immutable);
});

test("pages carry the security headers and a revalidating cache", async () => {
  const response = await get("/blog");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const referrer = "strict-origin-when-cross-origin";
  assert.equal(response.headers.get("referrer-policy"), referrer);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("cache-control") ?? "", /max-age=0/);
});

test("Pages gives the blog one canonical URL without redirect rules", async () => {
  for (const path of ["/blog.html", "/blog/"]) {
    const response = await get(path);
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("location"), "/blog", path);
  }
});

test("drafts are absent on Pages and feeds keep the revalidating cache", async () => {
  assert.equal((await get("/blog/draft")).status, 404);
  for (const path of ["/blog/rss.xml", "/sitemap-0.xml"]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /max-age=0/);
    assert.doesNotMatch(await response.text(), /\/blog\/draft/);
  }
});

test("unknown paths get the built 404 page", async () => {
  const response = await get("/no-such-post");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});

test("published articles and OG cards resolve, with canonical Pages variants", async () => {
  const post = await get("/blog/engine-probe");
  assert.equal(post.status, 200);
  assert.equal(post.headers.get("x-content-type-options"), "nosniff");
  assert.match(post.headers.get("cache-control") ?? "", /max-age=0/);
  assert.match(
    await post.text(),
    /https:\/\/foreman.steamfield.io\/blog\/engine-probe/,
  );
  for (const path of ["/blog/engine-probe/", "/blog/engine-probe.html"]) {
    const response = await get(path);
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("location"), "/blog/engine-probe", path);
  }
  const card = await get("/og/blog/engine-probe.webp");
  assert.equal(card.status, 200);
  assert.match(card.headers.get("content-type") ?? "", /image\/webp/);
  const bytes = Buffer.from(await card.arrayBuffer());
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
});
test("robots advertises the real sitemap and the legacy sitemap redirects", async () => {
  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(
    await robots.text(),
    /Sitemap: https:\/\/foreman.steamfield.io\/sitemap-index.xml/,
  );
  assert.equal((await get("/sitemap-index.xml")).status, 200);
  const legacy = await get("/sitemap.xml");
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get("location"), "/sitemap-index.xml");
});
