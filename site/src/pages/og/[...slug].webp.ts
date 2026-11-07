import type { APIRoute, GetStaticPaths } from "astro";
import satori from "satori";
import sharp from "sharp";
import { site } from "../../config";
import { blogTitle, blogDescription } from "../../lib/blog";
import { getRoutablePosts } from "../../lib/collection";
import { slugFor } from "../../lib/posts";
import { type Card, ogCard, ogFonts, ogLogo } from "../../lib/og";
export const getStaticPaths = (async () => [
  {
    params: { slug: "blog" },
    props: {
      title: blogTitle,
      description: blogDescription,
      siteName: site.title,
    },
  },
  ...(await getRoutablePosts()).map((post) => ({
    params: { slug: `blog/${slugFor(post)}` },
    props: {
      title: post.data.title,
      description: post.data.description,
      siteName: site.title,
    },
  })),
]) satisfies GetStaticPaths;
export const GET: APIRoute<Card> = async ({ props }) => {
  const svg = await satori(ogCard(props, await ogLogo()) as never, {
    width: 1200,
    height: 630,
    fonts: await ogFonts(),
  });
  const webp = await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
  return new Response(new Uint8Array(webp), {
    headers: { "Content-Type": "image/webp" },
  });
};
