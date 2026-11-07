import { expect, test } from "vitest";
import {
  publishedPosts,
  readingTime,
  relatedPosts,
  formatPostDate,
  routablePosts,
  slugFor,
} from "./posts";

const entries = [
  {
    id: "older.md",
    data: { status: "published", date: new Date("2025-01-01") },
  },
  { id: "draft.mdx", data: { status: "draft", date: new Date("2026-01-03") } },
  {
    id: "unlisted",
    data: { status: "unlisted", date: new Date("2026-01-02") },
  },
  { id: "newer", data: { status: "published", date: new Date("2026-01-01") } },
] satisfies Parameters<typeof publishedPosts>[0];

test("only published posts appear in listings, newest first, without mutating input", () => {
  expect(publishedPosts(entries).map(slugFor)).toEqual(["newer", "older"]);
  expect(entries[0]?.id).toBe("older.md");
});
test("production includes unlisted routes and dev also includes drafts", () => {
  expect(routablePosts(entries, false).map(slugFor)).toEqual([
    "older",
    "unlisted",
    "newer",
  ]);
  expect(routablePosts(entries, true)).toEqual(entries);
});
test("slugs keep nested paths and reading time has a one minute minimum", () => {
  expect(slugFor({ id: "notes/hello.mdx" })).toBe("notes/hello");
  expect(slugFor({ id: "notes/index.mdx" })).toBe("notes");
  expect(readingTime("")).toBe(1);
  expect(readingTime("word ".repeat(201))).toBe(2);
});

test("related posts prefer matching features, then newest, excluding the current and hidden posts", () => {
  const posts = entries.map((entry) => ({
    ...entry,
    data: {
      ...entry.data,
      feature: entry.id === "newer" ? "hooks" : "worktrees",
    },
  }));
  const current = {
    id: "current",
    data: {
      status: "published" as const,
      date: new Date("2026-01-05"),
      feature: "worktrees",
    },
  };
  expect(relatedPosts(current, [...posts, current]).map(slugFor)).toEqual([
    "older",
    "newer",
  ]);
  expect(
    relatedPosts(
      current,
      Array.from({ length: 5 }, (_, i) => ({ ...current, id: `other-${i}` })),
    ),
  ).toHaveLength(3);
});
test("display dates use UTC even near a day boundary", () => {
  expect(formatPostDate(new Date("2026-01-01T00:30:00Z"))).toBe(
    "January 1, 2026",
  );
});
