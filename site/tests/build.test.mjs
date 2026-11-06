import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Window } from "happy-dom";
import { loadEnv } from "vite";

const read = (path) => readFileSync(`dist/${path}`, "utf8");
const document = (path) => {
  const window = new Window();
  window.document.write(read(path));
  return window.document;
};

function assertAnalyticsBundle(root = ".") {
  const scripts = readdirSync(join(root, "dist/_astro"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(root, "dist/_astro", file), "utf8"))
    .join("\n");
  if (loadEnv("production", resolve(root), "PUBLIC_").PUBLIC_POSTHOG_KEY) {
    assert.match(scripts, /posthog/i);
    assert.match(scripts, /sf-consent/);
    assert.match(scripts, /steamfield.io\/privacy/);
  } else {
    assert.doesNotMatch(scripts, /posthog|sf-consent|consent-accept/i);
  }
}

test("the landing page owns the root and links the shared privacy page", () => {
  const page = document("index.html");
  assert.equal(page.querySelector("h1")?.textContent, "forman");
  assert.equal(
    page.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    "https://forman.steamfield.io/",
  );
  assert.equal(
    page.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    "https://forman.steamfield.io/",
  );
  assert.ok(
    page.querySelector('footer a[href="https://steamfield.io/privacy"]'),
  );
  assert.equal(page.querySelector('nav a[href^="/blog"]'), null);
  assert.ok(read("default-og.svg").includes("<svg"));
});
test("production has an empty blog and RSS, no draft page, and only the landing page in the sitemap", () => {
  assert.equal(existsSync("dist/blog/welcome.html"), false);
  assert.equal(existsSync("dist/welcome.html"), false);
  assert.equal(existsSync("dist/rss.xml"), false);
  assert.equal(document("blog.html").querySelector("h1")?.textContent, "Blog");
  assert.equal(
    document("blog.html").querySelector('a[href="/blog/welcome"]'),
    null,
  );
  assert.doesNotMatch(read("blog/rss.xml"), /<item>|welcome/);
  assert.deepEqual(
    [...read("sitemap-0.xml").matchAll(/<loc>(.*?)<\/loc>/g)].map(
      (match) => match[1],
    ),
    ["https://forman.steamfield.io/"],
  );
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

test("a production build hides drafts and renders unlisted posts without listing them", () => {
  const root = mkdtempSync(join(tmpdir(), "blog-build-"));
  const originalKey = process.env.PUBLIC_POSTHOG_KEY;
  try {
    delete process.env.PUBLIC_POSTHOG_KEY;
    for (const file of [
      "src",
      "public",
      "scripts",
      "astro.config.mjs",
      "tsconfig.json",
      "package.json",
    ]) {
      cpSync(file, join(root, file), { recursive: true });
    }
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(
      join(root, ".env.production"),
      "PUBLIC_POSTHOG_KEY=phc_test\n",
    );
    const welcome = join(root, "src/content/blog/welcome.mdx");
    writeFileSync(
      welcome,
      readFileSync(welcome, "utf8").replace(
        "status: draft",
        "status: published",
      ),
    );
    for (const status of ["draft", "unlisted"]) {
      writeFileSync(
        join(root, `src/content/blog/${status}.mdx`),
        `---\ntitle: ${status}\ndescription: Visibility probe\nauthor: Author\ndate: 2026-01-02\nstatus: ${status}\n---\n\nVisibility probe.\n`,
      );
    }
    mkdirSync(join(root, "src/content/blog/notes"));
    writeFileSync(
      join(root, "src/content/blog/notes/index.mdx"),
      `---\ntitle: Nested post\ndescription: Nested index probe\nauthor: Author\ndate: 2026-01-02\nstatus: published\n---\n\nNested content.\n`,
    );
    const built = spawnSync("bunx", ["--no-install", "astro", "build"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    assertAnalyticsBundle(root);
    const published = new Window().document;
    published.write(readFileSync(join(root, "dist/blog/welcome.html"), "utf8"));
    assert.equal(
      published.querySelector("h1")?.textContent,
      "Welcome to the field notes",
    );
    assert.ok(
      published.querySelector("h2")?.textContent.includes("small observation"),
    );
    assert.ok(published.querySelector("time")?.getAttribute("datetime"));
    assert.equal(
      published.querySelector('link[rel="canonical"]')?.getAttribute("href"),
      "https://forman.steamfield.io/blog/welcome",
    );
    assert.equal(
      published
        .querySelector('meta[property="og:url"]')
        ?.getAttribute("content"),
      "https://forman.steamfield.io/blog/welcome",
    );
    assert.ok(published.querySelector("astro-island"));
    assert.match(
      published
        .querySelector(".astro-code span[style]")
        ?.getAttribute("style") ?? "",
      /color:/,
    );
    assert.doesNotMatch(
      published.documentElement.outerHTML,
      /--shiki-dark|class="dark"/,
    );
    assert.equal(existsSync(join(root, "dist/blog/notes.html")), true);
    for (const file of ["blog.html", "blog/rss.xml", "sitemap-0.xml"]) {
      assert.match(
        readFileSync(join(root, "dist", file), "utf8"),
        /\/blog\/notes[<"]/,
      );
    }
    assert.equal(existsSync(join(root, "dist/blog/draft.html")), false);
    const hidden = new Window().document;
    hidden.write(readFileSync(join(root, "dist/blog/unlisted.html"), "utf8"));
    assert.equal(hidden.querySelector("h1")?.textContent, "unlisted");
    assert.equal(
      hidden.querySelector('meta[name="robots"]')?.getAttribute("content"),
      "noindex, nofollow",
    );
    for (const file of [
      "index.html",
      "blog.html",
      "blog/rss.xml",
      "sitemap-0.xml",
    ]) {
      assert.doesNotMatch(
        readFileSync(join(root, "dist", file), "utf8"),
        /\/(draft|unlisted)(?:[<"/]|$)/,
      );
    }
  } finally {
    if (originalKey === undefined) delete process.env.PUBLIC_POSTHOG_KEY;
    else process.env.PUBLIC_POSTHOG_KEY = originalKey;
    rmSync(root, { recursive: true, force: true });
  }
});
