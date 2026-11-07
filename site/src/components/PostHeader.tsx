import type { CollectionEntry } from "astro:content";
import { formatPostDate } from "../lib/posts";
export function PostHeader({
  post,
  minutes,
}: {
  post: CollectionEntry<"blog">;
  minutes: number;
}) {
  return (
    <header>
      <h1 className="font-display hero-title">
        {post.data.headline ?? post.data.title}
      </h1>
      <p className="text-ink-2 mt-6 text-xl">{post.data.description}</p>
      <p className="text-ink-3 mt-5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>{post.data.author}</span>
        <time dateTime={post.data.date.toISOString()}>
          {formatPostDate(post.data.date)}
        </time>
        {post.data.updated && (
          <span>
            Updated{" "}
            <time dateTime={post.data.updated.toISOString()}>
              {formatPostDate(post.data.updated)}
            </time>
          </span>
        )}
        <span>{minutes} min read</span>
      </p>
      {post.data.status !== "published" && (
        <p className="text-ink-3 mt-2 text-sm">{post.data.status}</p>
      )}
    </header>
  );
}
