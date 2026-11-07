import type { CollectionEntry } from "astro:content";
import { site } from "../config";
import { publishedPosts, slugFor } from "./posts";

type Post = CollectionEntry<"blog">;
export const blogTitle = "Delegating to Codex from Claude Code";
export const blogDescription =
  "Practical guides to running Codex from Claude Code: worktrees, contracts, questions, hooks, and reviewing the work before you commit.";
export const absolute = (path: string) => new URL(path, site.url).href;
export const postPath = (post: Pick<Post, "id">) => `/blog/${slugFor(post)}`;
export const postImage = (post: Post) =>
  post.data.ogImage ?? `/og/blog/${slugFor(post)}.webp`;

export function breadcrumbs(post?: Post) {
  const items = [
    { name: "Home", item: absolute("/") },
    { name: "Blog", ...(post ? { item: absolute("/blog") } : {}) },
    ...(post ? [{ name: post.data.title }] : []),
  ];
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      ...item,
    })),
  };
}

export function homeJsonLd() {
  return [
    {
      "@type": "WebSite",
      "@id": absolute("/#website"),
      url: absolute("/"),
      name: site.title,
      description: site.description,
    },
    {
      "@type": "SoftwareApplication",
      "@id": absolute("/#software"),
      name: "foreman",
      description: site.description,
      url: absolute("/"),
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      license: "https://opensource.org/licenses/MIT",
      sameAs: [site.repo, site.npm],
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ];
}

export function postJsonLd(post: Post) {
  const canonical = absolute(postPath(post));
  return {
    "@type": "BlogPosting",
    "@id": `${canonical}#article`,
    headline: post.data.headline ?? post.data.title,
    description: post.data.description,
    url: canonical,
    mainEntityOfPage: canonical,
    datePublished: post.data.date.toISOString(),
    dateModified: (post.data.updated ?? post.data.date).toISOString(),
    image: absolute(postImage(post)),
    keywords: post.data.keyword,
    inLanguage: "en",
    author: {
      "@type": "Person",
      name: "Riley Hilliard",
      url: "https://github.com/rileyhilliard",
    },
    publisher: {
      "@type": "Organization",
      name: "Steamfield",
      url: "https://steamfield.io",
    },
    isPartOf: { "@type": "Blog", "@id": absolute("/blog#blog") },
    about: { "@id": absolute("/#software") },
  };
}

export function collectionJsonLd(posts: readonly Post[]) {
  return {
    "@type": "CollectionPage",
    "@id": absolute("/blog#blog"),
    url: absolute("/blog"),
    name: blogTitle,
    description: blogDescription,
    isPartOf: { "@id": absolute("/#website") },
    about: { "@id": absolute("/#software") },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: publishedPosts(posts).map((post, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: absolute(postPath(post)),
        name: post.data.title,
      })),
    },
  };
}
