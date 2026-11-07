import type { CollectionEntry } from "astro:content";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { PostHeader } from "./PostHeader";
import { PostList } from "./PostList";

const post = {
  id: "welcome",
  collection: "blog",
  body: "Hello",
  data: {
    title: "Welcome",
    description:
      "A practical guide to running Codex in its own worktree, answering questions, and reviewing the result before committing changes.",
    keyword: "Codex worktree",
    feature: "worktrees",
    author: "Author",
    date: new Date("2026-01-01"),
    status: "published",
    tags: [],
  },
} satisfies CollectionEntry<"blog">;

test("post list omits drafts and unlisted posts", () => {
  render(
    <PostList
      posts={[
        post,
        {
          ...post,
          id: "draft",
          data: { ...post.data, title: "Draft", status: "draft" },
        },
        {
          ...post,
          id: "unlisted",
          data: { ...post.data, title: "Unlisted", status: "unlisted" },
        },
      ]}
    />,
  );
  expect(screen.getByRole("link", { name: "Welcome" })).toHaveAttribute(
    "href",
    "/blog/welcome",
  );
  expect(screen.queryByRole("link", { name: "Draft" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Unlisted" }),
  ).not.toBeInTheDocument();
});
test("post header renders the heading, author, date and reading time", () => {
  render(<PostHeader post={post} minutes={1} />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Welcome" }),
  ).toBeInTheDocument();
  expect(screen.getByText("January 1, 2026")).toHaveAttribute(
    "datetime",
    "2026-01-01T00:00:00.000Z",
  );
  expect(screen.getByText("Author")).toBeInTheDocument();
  expect(screen.getByText("1 min read")).toBeInTheDocument();
});
