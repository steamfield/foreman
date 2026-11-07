// Article writers: bunx astro build && node --test --test-name-pattern=blog tests/build.test.mjs
// The scoped command validates real articles and skips the temporary production pipeline rebuild.
import assert from "node:assert/strict";
import {
  existsSync,
  globSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, relative } from "node:path";
import test from "node:test";
import { getByRole, getByText } from "@testing-library/dom";
import { Window } from "happy-dom";
import { loadEnv } from "vite";

import { site } from "../src/config.ts";
import { frontmatter } from "../scripts/frontmatter.mjs";
import {
  buildFixtureSite,
  fixtureDescription,
  fixturePost,
} from "./blog-fixture.mjs";

const read = (path) => readFileSync(`dist/${path}`, "utf8");
const document = (path) => {
  const window = new Window();
  window.document.write(read(path));
  return window.document;
};

function assertAnalyticsBundle(
  root = ".",
  key = loadEnv("production", resolve(root), "PUBLIC_").PUBLIC_POSTHOG_KEY,
) {
  const scripts = readdirSync(join(root, "dist/_astro"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(root, "dist/_astro", file), "utf8"))
    .join("\n");
  if (key) {
    assert.match(scripts, /posthog/i);
    assert.match(scripts, /sf-consent/);
    assert.match(scripts, /steamfield.io\/privacy/);
  } else {
    assert.doesNotMatch(scripts, /posthog|sf-consent|consent-accept/i);
  }
}

test("the landing page owns the root and links the shared privacy page", () => {
  const page = document("index.html");
  assert.equal(
    page.querySelector("h1")?.textContent?.trim(),
    "Codex models as subagents for Claude Code.",
  );
  assert.equal(
    page.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    "https://foreman.steamfield.io/",
  );
  assert.equal(
    page.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    "https://foreman.steamfield.io/",
  );
  assert.ok(
    page.querySelector('footer a[href="https://steamfield.io/privacy"]'),
  );
  assert.ok(page.querySelector('header nav a[href="/blog"]'));
  assert.ok(page.querySelector('footer nav a[href="/blog"]'));
});

test("home metadata describes Codex subagents and publishes the exact entity graph", () => {
  const doc = document("index.html");
  const meta = (key) =>
    doc
      .querySelector(`meta[name="${key}"], meta[property="${key}"]`)
      ?.getAttribute("content");
  const title = doc.querySelector("title").textContent;
  assert.equal(title, "Codex subagents for Claude Code | foreman");
  assert.ok(title.length <= 60);
  assert.equal(meta("og:title"), title);
  assert.equal(meta("twitter:title"), title);
  const description = meta("description");
  assert.ok(description.length >= 150 && description.length <= 160);
  assert.equal(description, site.metaDescription);
  assert.equal(meta("og:description"), description);
  assert.equal(meta("twitter:description"), description);
  assert.equal(meta("og:type"), "website");
  assert.equal(meta("og:site_name"), "foreman");
  assert.equal(meta("og:locale"), "en_US");
  assert.equal(meta("og:image:alt"), title);
  assert.equal(meta("robots"), "max-snippet:-1, max-image-preview:large");
  assert.equal(
    doc.querySelector('link[rel="canonical"]').getAttribute("href"),
    "https://foreman.steamfield.io/",
  );
  assert.equal(doc.querySelectorAll("h1").length, 1);
  let previous = 0;
  for (const heading of doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const level = Number(heading.tagName.slice(1));
    assert.ok(
      level <= previous + 1,
      `Heading skips from h${previous} to h${level}: ${heading.textContent}`,
    );
    previous = level;
  }
  assert.deepEqual(graph(doc), [
    {
      "@type": "WebSite",
      "@id": "https://foreman.steamfield.io/#website",
      url: "https://foreman.steamfield.io/",
      name: "foreman",
      description: site.description,
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://foreman.steamfield.io/#software",
      name: "foreman",
      description: site.description,
      url: "https://foreman.steamfield.io/",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      license: "https://opensource.org/licenses/MIT",
      sameAs: [site.repo, site.npm],
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ]);
  for (const selector of [
    '[aria-label="Supervision console"] > div',
    '#commands [data-part="tabs"]',
    "#install figure",
    "#handoff figure",
    "[data-session-diagram]",
    '#parallel [aria-hidden="true"]',
  ]) {
    const element = doc.querySelector(selector);
    assert.ok(element, `missing recording: ${selector}`);
    const walker = doc.createTreeWalker(
      element,
      doc.defaultView.NodeFilter.SHOW_TEXT,
    );
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      assert.ok(
        text.parentElement?.closest(
          "div[data-nosnippet], span[data-nosnippet], section[data-nosnippet]",
        ),
        `snippet exclusion missing on supported element: ${selector}: ${text.textContent.slice(0, 60)}`,
      );
    }
  }
  const fallback = document("404.html");
  assert.equal(
    fallback.querySelector('meta[name="description"]').getAttribute("content"),
    site.metaDescription,
  );
});

test("every page carries the brand pack: favicon, touch icon, manifest and the social card", async () => {
  const brand = (name) => readFileSync(`public/brand/${name}`, "utf8");
  assert.equal(read("favicon.svg"), brand("foreman-icon.svg"));
  const manifest = JSON.parse(read("site.webmanifest"));
  assert.equal(manifest.name, "foreman");
  for (const icon of manifest.icons) assert.ok(existsSync(`dist${icon.src}`));
  const { default: sharp } = await import("sharp");
  const card = await sharp("dist/og/index.webp").metadata();
  assert.deepEqual([card.format, card.width, card.height], ["webp", 1200, 630]);
  for (const path of ["index.html", "blog.html", "404.html"]) {
    const page = document(path);
    const href = (selector, attribute = "href") =>
      page.querySelector(selector)?.getAttribute(attribute);
    assert.equal(href('link[rel="icon"]'), "/favicon.svg");
    assert.ok(existsSync(`dist${href('link[rel="apple-touch-icon"]')}`));
    assert.equal(href('link[rel="manifest"]'), "/site.webmanifest");
    for (const meta of [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
    ])
      assert.equal(
        href(meta, "content"),
        `https://foreman.steamfield.io/og/${path === "blog.html" ? "blog" : "index"}.webp`,
      );
    const logo = page.querySelector('header a[href="/"] svg[role="img"]');
    assert.equal(logo?.getAttribute("aria-label"), "foreman");
  }
});

for (const path of ["index.html", "blog.html", "404.html"]) {
  test(`${path} credits Steamfield with a linked logo in the footer`, () => {
    const page = document(path);
    const footer = getByRole(page.body, "contentinfo");
    const link = getByRole(footer, "link", {
      name: "Steamfield",
      exact: true,
    });
    assert.equal(link.getAttribute("href"), "https://steamfield.io");
    const credit = getByText(footer, "Made by", { exact: true });
    assert.ok(
      credit.compareDocumentPosition(link) &
        page.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const logo = link.querySelector("svg");
    assert.ok(logo);
    assert.equal(logo.getAttribute("viewBox"), "0 0 145.59 26");
    assert.equal(logo.getAttribute("height"), "22");
    const paths = logo.querySelectorAll("path");
    assert.equal(paths.length, 2);
    for (const path of paths) {
      assert.equal(path.getAttribute("fill"), "currentColor");
    }
    assert.ok(getByText(footer, "foreman is MIT licensed.", { exact: true }));
    assert.doesNotMatch(footer.textContent, /A Steamfield project\./);
  });
}

test("blog production content follows publication rules even with zero real posts", async () => {
  await assertBlog(".");
});
test("the error page tells readers how to recover and stays out of search", () => {
  const page = document("404.html");
  assert.equal(page.querySelector("h1")?.textContent, "Page not found");
  assert.ok(page.querySelector('a[href="/"]'));
  assert.equal(
    page.querySelector('meta[name="robots"]')?.getAttribute("content"),
    "noindex, nofollow",
  );
});

test("only a keyed build ships analytics and consent JavaScript", () => {
  assertAnalyticsBundle();
});

test("llms.txt includes the install command and every exit code", () => {
  assert.ok(existsSync("dist/llms.txt"));
  const text = read("llms.txt");
  assert.match(text, /^# foreman\n/);
  assert.ok(text.includes("npm i -g @steamfield/foreman"));
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 130]) {
    assert.match(text, new RegExp(`^\\| ${code} \\| .+ \\|$`, "m"));
  }
});

const origin = "https://foreman.steamfield.io";
function pageAt(root, path) {
  const doc = new Window().document;
  doc.write(readFileSync(join(root, "dist", path), "utf8"));
  return doc;
}
function graph(doc) {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  assert.equal(scripts.length, 1);
  assert.ok(!scripts[0].textContent.includes("<"), "JSON-LD must escape <");
  const value = JSON.parse(scripts[0].textContent);
  function noAbsent(value) {
    assert.notEqual(value, null);
    assert.notEqual(value, undefined);
    if (typeof value === "object") Object.values(value).forEach(noAbsent);
  }
  noAbsent(value);
  return value["@graph"];
}
function assertLinks(root, doc, route) {
  const ids = [...doc.querySelectorAll("[id]")].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id on ${route}`);
  for (const a of doc.querySelectorAll("a[href]")) {
    const url = new URL(a.getAttribute("href"), `${origin}${route}`);
    if (url.origin !== origin) continue;
    const path = decodeURIComponent(url.pathname);
    const file = join(
      root,
      "dist",
      path === "/"
        ? "index.html"
        : /\.[^/]+$/.test(path)
          ? path
          : `${path}.html`,
    );
    assert.ok(
      existsSync(file),
      `broken link ${a.getAttribute("href")} on ${route}`,
    );
    if (url.hash) {
      const target = new Window().document;
      target.write(readFileSync(file, "utf8"));
      assert.ok(
        target.getElementById(decodeURIComponent(url.hash.slice(1))),
        `missing anchor ${url.href}`,
      );
    }
  }
}
async function assertCard(root, path) {
  const { default: sharp } = await import("sharp");
  const card = await sharp(join(root, "dist", path)).metadata();
  assert.deepEqual([card.format, card.width, card.height], ["webp", 1200, 630]);
}
async function assertBlog(root) {
  const read = (path) => readFileSync(join(root, "dist", path), "utf8");
  const posts = [...globSync(join(root, "src/content/blog/**/*.{md,mdx}"))].map(
    (file) => {
      const data = frontmatter(readFileSync(file, "utf8"));
      // Match the collection schema's trimming; compare the normalized public values.
      for (const field of ["title", "headline", "description", "keyword"]) {
        if (typeof data[field] === "string") data[field] = data[field].trim();
      }
      return {
        slug: relative(join(root, "src/content/blog"), file)
          .replace(/\.(md|mdx)$/, "")
          .replace(/\/index$/, ""),
        data,
      };
    },
  );
  const published = posts
    .filter((post) => (post.data.status ?? "published") === "published")
    .sort(
      (a, b) =>
        new Date(b.data.date) - new Date(a.data.date) ||
        a.slug.localeCompare(b.slug),
    );
  const index = pageAt(root, "blog.html");
  const meta = (doc, key) =>
    doc
      .querySelector(`meta[name="${key}"], meta[property="${key}"]`)
      ?.getAttribute("content");
  assert.equal(index.querySelectorAll("h1").length, 1);
  assert.equal(
    meta(index, "robots"),
    published.length
      ? "max-snippet:-1, max-image-preview:large"
      : "noindex, nofollow",
  );
  const collection = graph(index).find(
    (item) => item["@type"] === "CollectionPage",
  );
  assert.equal(collection["@id"], `${origin}/blog#blog`);
  assert.equal(collection.isPartOf["@id"], `${origin}/#website`);
  assert.equal(collection.about["@id"], `${origin}/#software`);
  assert.equal(collection.mainEntity["@type"], "ItemList");
  const urls = published.map((post) => `${origin}/blog/${post.slug}`);
  assert.deepEqual(
    collection.mainEntity.itemListElement.map((item) => item.url),
    urls,
  );
  assert.deepEqual(
    [...index.querySelectorAll("main h2 a")].map(
      (a) => new URL(a.getAttribute("href"), origin).href,
    ),
    urls,
  );
  assert.ok(
    !(
      "item" in
      graph(index)
        .find((item) => item["@type"] === "BreadcrumbList")
        .itemListElement.at(-1)
    ),
  );
  assertLinks(root, index, "/blog");
  await assertCard(root, "og/blog.webp");
  const rss = new Window().DOMParser;
  const feed = new rss().parseFromString(
    read("blog/rss.xml"),
    "application/xml",
  );
  assert.equal(feed.querySelectorAll("parsererror").length, 0);
  assert.equal(feed.querySelectorAll("channel").length, 1);
  assert.deepEqual(
    [...feed.querySelectorAll("item > link")].map((el) => el.textContent),
    urls,
  );
  const sitemap = read("sitemap-0.xml");
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]).sort(),
    [
      `${origin}/`,
      ...(published.length ? [`${origin}/blog`] : []),
      ...urls,
    ].sort(),
  );
  assert.match(read("sitemap-index.xml"), /sitemap-0.xml/);
  assert.equal(
    read("robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap-index.xml\n`,
  );
  const software = graph(pageAt(root, "index.html")).find(
    (item) => item["@type"] === "SoftwareApplication",
  );
  assert.equal(software["@id"], `${origin}/#software`);
  assert.deepEqual(software.offers, {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  });
  for (const post of posts) {
    const route = `/blog/${post.slug}`;
    const url = `${origin}${route}`;
    const status = post.data.status ?? "published";
    const exists = existsSync(join(root, "dist", `${route}.html`));
    assert.equal(exists, status !== "draft", route);
    if (status !== "published") {
      for (const text of [
        index.documentElement.outerHTML,
        sitemap,
        read("blog/rss.xml"),
        read("llms.txt"),
        ...published.map((other) => read(`blog/${other.slug}.html`)),
      ])
        assert.ok(
          !text.includes(url) && !text.includes(`href="${route}"`),
          `${status} listed: ${route}`,
        );
      if (status === "draft") {
        assert.equal(
          existsSync(join(root, "dist/og/blog", `${post.slug}.webp`)),
          false,
        );
        continue;
      }
    }
    const doc = pageAt(root, `${route}.html`);
    assert.equal(
      meta(doc, "robots"),
      status === "published"
        ? "max-snippet:-1, max-image-preview:large"
        : "noindex, nofollow",
    );
    assert.equal(doc.querySelectorAll("h1").length, 1);
    assert.equal(
      doc.querySelector("h1").textContent.trim(),
      post.data.headline ?? post.data.title,
    );
    const title = doc.querySelector("title").textContent;
    assert.ok(title.length <= 60);
    assert.equal(meta(doc, "og:title"), title);
    assert.equal(meta(doc, "twitter:title"), title);
    const description = meta(doc, "description");
    assert.ok(description.length >= 120 && description.length <= 160);
    assert.equal(meta(doc, "og:description"), description);
    assert.equal(meta(doc, "twitter:description"), description);
    assert.equal(
      doc.querySelector('link[rel="canonical"]').getAttribute("href"),
      url,
    );
    assert.equal(meta(doc, "og:url"), url);
    assert.equal(meta(doc, "og:type"), "article");
    const date = new Date(post.data.date).toISOString();
    const updated = new Date(post.data.updated ?? post.data.date).toISOString();
    assert.equal(meta(doc, "article:published_time"), date);
    assert.equal(meta(doc, "article:modified_time"), updated);
    const article = graph(doc).find((item) => item["@type"] === "BlogPosting");
    assert.equal(article.about["@id"], software["@id"]);
    assert.equal(article.datePublished, date);
    assert.equal(article.dateModified, updated);
    assert.equal(article.image, meta(doc, "og:image"));
    assert.equal(article.url, url);
    assert.equal(article.mainEntityOfPage, url);
    assert.equal(article.headline, post.data.headline ?? post.data.title);
    assert.equal(article.keywords, post.data.keyword);
    const crumbs = graph(doc).find(
      (item) => item["@type"] === "BreadcrumbList",
    ).itemListElement;
    assert.deepEqual(
      crumbs.map((item) => item.name),
      ["Home", "Blog", post.data.title],
    );
    assert.ok(!("item" in crumbs.at(-1)));
    assert.equal(
      doc.querySelector('[aria-current="page"]').textContent.trim(),
      post.data.title,
    );
    await assertCard(root, `og/blog/${post.slug}.webp`);
    assertLinks(root, doc, route);
    const headings = [...doc.querySelectorAll(".prose h2")];
    for (const nav of doc.querySelectorAll('nav[aria-label="On this page"]'))
      assert.deepEqual(
        [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        headings.map((h) => `#${h.id}`),
      );
    assert.equal(
      doc.querySelectorAll("[data-toc]").length,
      headings.length ? 1 : 0,
    );
    if (status === "published") {
      assert.ok(
        read("llms.txt").includes(
          `- [${post.data.title}](${url}): ${post.data.description}`,
        ),
      );
      const item = [...feed.querySelectorAll("item")].find(
        (item) => item.querySelector("link").textContent === url,
      );
      assert.equal(
        new Date(item.querySelector("pubDate").textContent).toISOString(),
        date,
      );
    }
  }
}

test("temporary production pipeline renders MDX, hides drafts and isolates unlisted posts", async () => {
  const root = buildFixtureSite();
  try {
    assertAnalyticsBundle(root, "phc_test");
    await assertBlog(root);
    const doc = pageAt(root, "blog/engine-probe.html");
    assert.equal(doc.querySelectorAll(".prose h2").length, 3);
    assert.equal(
      doc.querySelectorAll("figure.not-prose > [data-nosnippet]").length,
      2,
    );
    assert.ok(doc.querySelector("astro-island"));
    assert.match(
      doc.querySelector(".astro-code span[style]")?.getAttribute("style") ?? "",
      /color:/,
    );
    assert.doesNotMatch(
      doc.documentElement.outerHTML,
      /--shiki-dark|class="dark"/,
    );
    assert.ok(doc.querySelector('[aria-label="Install foreman"]'));
    assert.ok(doc.querySelector('#more-posts + ul a[href="/blog/notes"]'));
    writeFileSync(
      join(root, "src/content/blog/engine-probe.mdx"),
      fixturePost().replaceAll('command="doctor"', 'command="bad-recording"'),
    );
    const bad = spawnSync("bunx", ["--no-install", "astro", "build"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.notEqual(bad.status, 0);
    assert.match(
      bad.stdout + bad.stderr,
      /CommandDemo: unknown command 'bad-recording'/,
    );
    for (const name of [
      "answer",
      "archive",
      "doctor",
      "result",
      "start-wait",
      "status-release",
      "wait-all",
    ])
      assert.ok((bad.stdout + bad.stderr).includes(name));
    writeFileSync(
      join(root, "src/content/blog/engine-probe.mdx"),
      fixturePost().replace(fixtureDescription, "Too short"),
    );
    const invalid = spawnSync("bunx", ["--no-install", "astro", "build"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /engine-probe\.mdx/);
    assert.match(
      invalid.stdout + invalid.stderr,
      /description must have at least 120 characters/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
