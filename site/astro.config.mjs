import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwind from "@tailwindcss/vite";
import { globSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { defineConfig } from "astro/config";
import { frontmatter } from "./scripts/frontmatter.mjs";
import { site } from "./src/config.ts";
import { publishedPosts, slugFor } from "./src/lib/posts.ts";
import { postSchema } from "./src/content/schema.ts";
import { guideId } from "./src/lib/guide.ts";

// Config runs before astro:content exists. Decode the same schema from real YAML.
const entries = Array.from(globSync("src/content/blog/**/*.{md,mdx}")).map(
  (file) => {
    const result = postSchema.safeParse(
      frontmatter(readFileSync(file, "utf8")),
    );
    if (!result.success)
      throw new Error(`Post ${file}: ${result.error.message}`);
    return { id: relative("src/content/blog", file), data: result.data };
  },
);
// The docs pages are the repository guide's files; the docs loader in content.config.ts
// validates them while it renders.
const guideIds = globSync("*.md", { cwd: "../docs/guide" }).map(guideId);

const listedPaths = new Set([
  "/",
  ...(publishedPosts(entries).length ? ["/blog"] : []),
  ...publishedPosts(entries).map((post) => `/blog/${slugFor(post)}`),
  "/docs",
  ...guideIds.map((id) => `/docs/${id}`),
]);

export default defineConfig({
  site: site.url,
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [
    mdx(),
    react(),
    sitemap({ filter: (page) => listedPaths.has(new URL(page).pathname) }),
  ],
  markdown: {
    shikiConfig: { theme: "github-light" },
  },
  vite: { plugins: [tailwind()] },
});
