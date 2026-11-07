// @vitest-environment node
import { globSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { frontmatter } from "../../scripts/frontmatter.mjs";
import { postSchema } from "./schema";

const valid = {
  title: "Hello",
  description: "A".repeat(120),
  keyword: "Codex worktree",
  feature: "worktrees",
  date: "2026-01-01",
};
test("valid frontmatter coerces dates and defaults status and tags", () => {
  expect(postSchema.parse(valid)).toMatchObject({
    date: new Date("2026-01-01"),
    status: "published",
    tags: [],
    author: "Riley Hilliard",
  });
});
test("missing titles, unknown statuses and invalid dates fail validation", () => {
  const { title, ...missingTitle } = valid;
  expect(postSchema.safeParse(missingTitle).success).toBe(false);
  expect(postSchema.safeParse({ ...valid, status: "private" }).success).toBe(
    false,
  );
  expect(postSchema.safeParse({ ...valid, date: "not a date" }).success).toBe(
    false,
  );
});
test("every real post parses as YAML and passes the collection schema", () => {
  const files = Array.from(globSync("src/content/blog/**/*.{md,mdx}"));
  for (const file of files)
    expect(
      () => postSchema.parse(frontmatter(readFileSync(file, "utf8"))),
      file,
    ).not.toThrow();
});

test.each([
  ["title", "", "at least 1"],
  ["title", "a".repeat(49), "at most 48"],
  ["headline", "a".repeat(111), "at most 110"],
  ["description", "a".repeat(119), "at least 120"],
  ["description", "a".repeat(161), "at most 160"],
  ["keyword", "", "at least 1"],
  ["feature", "unknown", "feature"],
  ["updated", "2025-12-31", "on or after date"],
])("%s errors name the field and constraint", (field, value, limit) => {
  const result = postSchema.safeParse({ ...valid, [field]: value });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.message).toContain(field);
    expect(result.error.message).toContain(limit);
  }
});
test("inclusive schema bounds and same-day updates parse", () => {
  expect(() =>
    postSchema.parse({
      ...valid,
      title: "a".repeat(48),
      headline: "a".repeat(110),
      description: "a".repeat(160),
      updated: valid.date,
    }),
  ).not.toThrow();
});
