/**
 * Content collections: blog posts from src/content/blog, and docs pages from the repository
 * guide in ../docs/guide. The guide loader derives each page's metadata with src/lib/guide.ts
 * and renders the Markdown with its h1 removed (the docs layout renders the title) and its
 * guide links rewritten to site routes, so a broken guide link fails the build.
 */
import { defineCollection } from "astro:content";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { glob, type Loader, type LoaderContext } from "astro/loaders";
import { docSchema, postSchema } from "./content/schema";
import { guideBody, guideData, guideId, guideMarkdown } from "./lib/guide";
import { slugFor } from "./lib/posts";

/** The guide source, relative to the site root. Subdirectories and other files are ignored. */
const GUIDE_DIR = "../docs/guide";

/**
 * Loads one guide file into the docs store.
 * @throws When the file has no h1, no sidebar place or a broken guide link, naming the file.
 */
async function loadGuideFile(context: LoaderContext, file: string) {
  const filePath = `${GUIDE_DIR}/${file}`;
  const fileURL = new URL(filePath, context.config.root);
  const source = readFileSync(fileURL, "utf8");
  const id = guideId(file);
  try {
    const data = await context.parseData({
      id,
      filePath,
      data: guideData(id, source),
    });
    const rendered = await context.renderMarkdown(
      guideMarkdown(guideBody(source)),
      { fileURL },
    );
    const digest = context.generateDigest(source);
    context.store.set({ id, data, body: source, filePath, digest, rendered });
  } catch (error) {
    throw new Error(`docs/guide/${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** Every `*.md` file directly in the guide directory, reloaded when one changes in dev. */
const repositoryGuide: Loader = {
  name: "repository-guide",
  load: async (context) => {
    const guideRoot = fileURLToPath(
      new URL(`${GUIDE_DIR}/`, context.config.root),
    );
    const reload = async () => {
      context.store.clear();
      for (const file of globSync("*.md", { cwd: guideRoot }))
        await loadGuideFile(context, file);
    };
    await reload();
    // Dev only: a broken edit is reported and the next save reloads again.
    context.watcher?.add(guideRoot);
    context.watcher?.on("all", (_event, path) => {
      if (!path.startsWith(guideRoot)) return;
      reload().catch((error: Error) => context.logger.error(error.message));
    });
  },
};

export const collections = {
  blog: defineCollection({
    loader: glob({
      pattern: "**/*.{md,mdx}",
      base: "./src/content/blog",
      generateId: ({ entry }) => slugFor({ id: entry }),
    }),
    schema: postSchema,
  }),
  docs: defineCollection({
    loader: repositoryGuide,
    schema: docSchema,
  }),
};
