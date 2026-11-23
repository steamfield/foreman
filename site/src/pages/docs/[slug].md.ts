/** Each docs page as Markdown at /docs/<id>.md, linked from the page head as rel="alternate". */
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { type DocEntry, toMarkdownExport } from "../../lib/docs";

export async function getStaticPaths() {
  return (await getCollection("docs")).map((entry) => ({
    params: { slug: entry.id },
    props: entry,
  }));
}

export const GET: APIRoute<DocEntry> = ({ props }) =>
  new Response(toMarkdownExport(props), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
