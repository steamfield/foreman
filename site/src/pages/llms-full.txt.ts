/** llms-full.txt: every docs page's Markdown export in sidebar order, for agents. */
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { docsGroups, site } from "../config";
import { docsNav, llmsFull } from "../lib/docs";

export const GET: APIRoute = async () => {
  const docs = await getCollection("docs");
  return new Response(llmsFull(site, docsNav(docs, docsGroups), docs), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
