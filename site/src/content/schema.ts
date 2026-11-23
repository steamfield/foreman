import { z } from "astro/zod";
import { docsGroups, site } from "../config";

export const postSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "title must have at least 1 character")
      .max(48, "title must have at most 48 characters"),
    headline: z
      .string()
      .trim()
      .min(1, "headline must have at least 1 character")
      .max(110, "headline must have at most 110 characters")
      .optional(),
    description: z
      .string()
      .trim()
      .min(120, "description must have at least 120 characters")
      .max(160, "description must have at most 160 characters"),
    keyword: z.string().trim().min(1, "keyword must have at least 1 character"),
    feature: z.enum([
      "delegation",
      "parallel",
      "worktrees",
      "background",
      "questions",
      "review",
      "contracts",
      "hooks",
      "safety",
    ]),
    date: z.coerce.date({ message: "date must be a valid date" }),
    updated: z.coerce
      .date({ message: "updated must be a valid date" })
      .optional(),
    author: z.string().trim().min(1).default(site.author),
    tags: z.array(z.string()).default([]),
    status: z.enum(["draft", "published", "unlisted"]).default("published"),
    cover: z.string().optional(),
    ogImage: z.string().optional(),
  })
  .refine((post) => !post.updated || post.updated >= post.date, {
    path: ["updated"],
    message: "updated must be on or after date",
  });

/** One docs sidebar section id from `docsGroups`. */
export type DocsGroupId = (typeof docsGroups)[number]["id"];

const docsGroupIds = docsGroups.map((group) => group.id) as [
  DocsGroupId,
  ...DocsGroupId[],
];

/** Docs page metadata, derived from each guide file by `guideData` in src/lib/guide.ts. */
export const docSchema = z.object({
  title: z.string().trim().min(1),
  /** Meta description, docs-home card text and the llms.txt summary. */
  description: z.string().trim().max(160),
  group: z.enum(docsGroupIds),
  /** Position inside the group; ties sort by title. */
  order: z.number().int(),
});

/** The validated metadata of one docs page. */
export type DocData = z.infer<typeof docSchema>;
