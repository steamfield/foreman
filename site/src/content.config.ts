/**
 * Content collections: blog posts from src/content/blog, and docs pages from the repository
 * guide in ../docs/guide (loaded by src/lib/guide-loader.ts).
 */
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docSchema, postSchema } from "./content/schema";
import { repositoryGuide } from "./lib/guide-loader";
import { slugFor } from "./lib/posts";

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
