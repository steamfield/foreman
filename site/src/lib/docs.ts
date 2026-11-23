/**
 * Docs rules for the site: routes, sidebar order, the pager, the h2 outline and the
 * agent-readable Markdown exports. Pages pass in the docs collection, so nothing here needs
 * the Astro runtime.
 */
import type { DocData } from "../content/schema";
import { guideBody, guideMarkdown } from "./guide";

/** A docs page as the collection provides it; `body` is the raw guide Markdown. */
export type DocEntry = { id: string; data: DocData; body?: string };
/** A sidebar section from `docsGroups`. */
export type Group = { readonly id: string; readonly label: string };
/** One page link in the sidebar, the docs home and the pager. */
export type NavItem = { id: string; title: string; description: string };
/** One sidebar section with its pages in order. */
export type NavGroup = { id: string; label: string; items: NavItem[] };
/** The site name and summary that head llms-full.txt. */
export type SiteInfo = { title: string; description: string };
/** One h2 in a page's sidebar outline; `code` marks a heading that is a command signature. */
export type OutlineItem = { slug: string; label: string; code: boolean };
/** A heading as Astro's `render` reports it. */
export type Heading = { depth: number; slug: string; text: string };

/** The HTML route of a docs page. */
export const docHref = (id: string) => `/docs/${id}`;
/** The route of a docs page's Markdown export. */
export const markdownHref = (id: string) => `/docs/${id}.md`;

/** A heading line whose whole text is one code span, such as a CLI signature. */
const CODE_ONLY_H2 = /^## `([^`\n]+)`[ \t]*\r?$/gm;
/** A signature word that starts the arguments: `<name>`, `[dir]`, `--flag` or `a|b`. */
const ARGUMENT_WORD = /^[<[-]|\|/;

const byOrder = (a: DocEntry, b: DocEntry) =>
  a.data.order - b.data.order || a.data.title.localeCompare(b.data.title);

/** Sidebar groups in config order, each page sorted by `order` then title. Empty groups drop out. */
export function docsNav(
  entries: readonly DocEntry[],
  groups: readonly Group[],
): NavGroup[] {
  return groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: entries
        .filter((entry) => entry.data.group === group.id)
        .sort(byOrder)
        .map((entry) => ({
          id: entry.id,
          title: entry.data.title,
          description: entry.data.description,
        })),
    }))
    .filter((group) => group.items.length > 0);
}

/** Previous and next pages in sidebar order, across group boundaries. */
export function pageLinks(nav: readonly NavGroup[], id: string) {
  const flat = nav.flatMap((group) => group.items);
  const index = flat.findIndex((item) => item.id === id);
  if (index === -1) return { prev: undefined, next: undefined };
  return { prev: flat[index - 1], next: flat[index + 1] };
}

/**
 * The Markdown served beside each page at `/docs/<id>.md`: title, description as a quote, then
 * the guide body with guide links pointing at site routes.
 * @throws When the body links to a guide file that is not a docs page.
 */
export function toMarkdownExport(entry: DocEntry): string {
  const body = guideMarkdown(guideBody(entry.body ?? ""));
  return `# ${entry.data.title}\n\n> ${entry.data.description}\n\n${body}\n`;
}

/**
 * llms-full.txt: the site summary, then every page's Markdown export in sidebar order.
 * @throws When a page links to a guide file that is not a docs page.
 */
export function llmsFull(
  site: SiteInfo,
  nav: readonly NavGroup[],
  entries: readonly DocEntry[],
): string {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const pages = nav
    .flatMap((group) => group.items)
    .map((item) => byId.get(item.id))
    .filter((entry) => entry !== undefined)
    .map(toMarkdownExport);
  return `# ${site.title}\n\n> ${site.description}\n\n${pages.join("\n")}`;
}

/** The words of a command signature before its first argument: `foreman start <name>` is `foreman start`. */
export function commandName(signature: string): string {
  const words = signature.split(/\s+/);
  const end = words.findIndex((word) => ARGUMENT_WORD.test(word));
  return end > 0 ? words.slice(0, end).join(" ") : signature;
}

/**
 * A page's h2s for the sidebar. An h2 whose Markdown is one code span (a CLI signature) is
 * labelled with just the command and flagged `code`; the heading and its anchor are unchanged.
 */
export function outline(
  headings: readonly Heading[],
  body: string,
): OutlineItem[] {
  const codeOnly = new Set(
    Array.from(body.matchAll(CODE_ONLY_H2), (match) => match[1] ?? ""),
  );
  return headings
    .filter((heading) => heading.depth === 2)
    .map(({ slug, text }) =>
      codeOnly.has(text)
        ? { slug, label: commandName(text), code: true }
        : { slug, label: text, code: false },
    );
}
