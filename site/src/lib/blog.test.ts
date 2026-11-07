import { expect, test } from "vitest";
import { postSchema } from "../content/schema";
import {
  absolute,
  breadcrumbs,
  collectionJsonLd,
  homeJsonLd,
  postImage,
  postJsonLd,
} from "./blog";
const post = {
  id: "guide",
  collection: "blog" as const,
  data: postSchema.parse({
    title: "Codex worktrees",
    description: "a".repeat(120),
    keyword: "Codex worktrees",
    feature: "worktrees",
    date: "2026-01-01",
  }),
};
function noAbsent(value: unknown) {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  if (typeof value === "object" && value !== null)
    Object.values(value).forEach(noAbsent);
}
test("home and article graphs share software identity and contain no absent values", () => {
  const home = homeJsonLd();
  const article = postJsonLd(post);
  noAbsent([
    home,
    article,
    breadcrumbs(post),
    breadcrumbs(),
    collectionJsonLd([post]),
  ]);
  expect(article.about["@id"]).toBe(home[1]?.["@id"]);
  expect(article.dateModified).toBe(article.datePublished);
  expect(article.image).toBe(absolute("/og/blog/guide.webp"));
  expect(article.author.url).toBe("https://github.com/rileyhilliard");
  expect(article.publisher.name).toBe("Steamfield");
  expect(breadcrumbs(post).itemListElement.at(-1)).not.toHaveProperty("item");
  expect(breadcrumbs().itemListElement.at(-1)).not.toHaveProperty("item");
});
test("article overrides use headline, updated date and custom image", () => {
  const other = {
    ...post,
    data: {
      ...post.data,
      headline: "A longer heading",
      updated: new Date("2026-02-01"),
      ogImage: "/custom.webp",
    },
  };
  expect(postJsonLd(other)).toMatchObject({
    headline: "A longer heading",
    dateModified: "2026-02-01T00:00:00.000Z",
    image: absolute("/custom.webp"),
  });
  expect(postImage(other)).toBe("/custom.webp");
});
test("collection graph contains only published posts newest first", () => {
  const newer = {
    ...post,
    id: "newer",
    data: { ...post.data, date: new Date("2026-02-01") },
  };
  const hidden = {
    ...post,
    id: "hidden",
    data: { ...post.data, status: "unlisted" as const },
  };
  expect(
    collectionJsonLd([post, hidden, newer]).mainEntity.itemListElement.map(
      (item) => item.url,
    ),
  ).toEqual([absolute("/blog/newer"), absolute("/blog/guide")]);
});
