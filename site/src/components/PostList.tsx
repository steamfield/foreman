import type { CollectionEntry } from "astro:content";
import {
  formatPostDate,
  publishedPosts,
  readingTime,
  slugFor,
} from "../lib/posts";
export function PostList({
  posts,
}: {
  posts: ReadonlyArray<CollectionEntry<"blog">>;
}) {
  return (
    <ul className="divide-line divide-y">
      {publishedPosts(posts).map((post) => (
        <li key={post.id} className="py-8 first:pt-0">
          <h2 className="font-display text-2xl">
            <a className="text-ink" href={`/blog/${slugFor(post)}`}>
              {post.data.headline ?? post.data.title}
            </a>
          </h2>
          <p className="text-ink-2 mt-3">{post.data.description}</p>
          <p className="text-ink-3 mt-3 text-sm">
            <time dateTime={post.data.date.toISOString()}>
              {formatPostDate(post.data.date)}
            </time>{" "}
            · {readingTime(post.body ?? "")} min read
          </p>
        </li>
      ))}
    </ul>
  );
}
