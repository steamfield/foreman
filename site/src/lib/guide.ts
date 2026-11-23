/**
 * The repository guide (`../docs/guide/*.md`) as docs pages. Guide files are plain Markdown
 * with no frontmatter so they read well on GitHub; this module derives each page's id, title,
 * description and sidebar place, and rewrites links between guide files into site routes.
 * Everything here is pure: callers read the files and hand over their text.
 */
import type { DocData, DocsGroupId } from "../content/schema";

type Placement = { group: DocsGroupId; order: number };

/** Where every guide page sits in the docs sidebar. A guide file missing here fails the build. */
const placements: Readonly<Record<string, Placement>> = {
  overview: { group: "getting-started", order: 0 },
  "getting-started": { group: "getting-started", order: 1 },
  "repo-setup": { group: "getting-started", order: 2 },
  providers: { group: "guides", order: 0 },
  delegating: { group: "guides", order: 1 },
  monitor: { group: "guides", order: 2 },
  "how-it-works": { group: "guides", order: 3 },
  cli: { group: "reference", order: 0 },
  configuration: { group: "reference", order: 1 },
};

/** Meta descriptions longer than this are cut and end in "...". */
const DESCRIPTION_LIMIT = 160;
const ELLIPSIS = "...";

/** A relative link to another guide file: `cli.md`, `./cli.md#exit-codes`. */
const GUIDE_LINK = /^(?:\.\/)?([\w-]+\.md)(#.*)?$/;
/** Links the site serves as written: an in-page anchor, a site path, or a URL with a scheme. */
const PASS_THROUGH = /^(?:#|\/|[a-z][a-z\d+.-]*:)/i;
const TITLE_LINE = /^# \S/;
const BYTE_ORDER_MARK = /^\uFEFF/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+).*?\1/g;
const INLINE_TARGET = /(\]\(\s*<?)([^\s)>]+)/g;
const DEFINITION = /^( {0,3}\[[^\]]+\]:\s*<?)([^\s>]+)/;

/** One source line and whether it belongs to a fenced code block, fence lines included. */
type Line = { text: string; code: boolean };

/** The page id for a guide file: its name without `.md`, with README as `overview`. */
export function guideId(file: string): string {
  const name = file.replace(/\.md$/, "");
  return name === "README" ? "overview" : name;
}

/**
 * The docs metadata of one guide page: the h1 as title, the first paragraph after it as the
 * description (link syntax, backticks and emphasis stripped), and its sidebar place.
 * @throws When the page has no h1 outside fenced code, no paragraph right after it, or no entry
 * in the sidebar placements.
 */
export function guideData(id: string, body: string): DocData {
  const lines = scanLines(body);
  const titleAt = lines.findIndex(isTitle);
  const title = lines[titleAt]?.text.slice(2).trim();
  if (!title) throw new Error(`Guide ${id} needs a level-one title.`);
  const placement = placements[id];
  if (!placement)
    throw new Error(
      `Guide ${id} has no place in the docs sidebar. Add it to placements in site/src/lib/guide.ts.`,
    );
  const paragraph = firstParagraph(lines.slice(titleAt + 1));
  if (!paragraph)
    throw new Error(
      `Guide ${id} needs a summary paragraph after its title; it becomes the page description.`,
    );
  return { title, description: summarize(paragraph), ...placement };
}

/**
 * The site route for a guide-relative link. Anchors, site paths and links with a scheme
 * (`https:`, `mailto:`) are returned unchanged.
 * @throws When the link names a guide file that is not a docs page, or is any other relative
 * path (`../README.md`, `images/x.png`), which would not resolve on the site.
 */
export function guideLink(href: string): string {
  const match = GUIDE_LINK.exec(href);
  if (!match) {
    if (PASS_THROUGH.test(href)) return href;
    throw new Error(
      `Guide link ${href} is a repository path that does not resolve on the site. Link repo files with their GitHub URL.`,
    );
  }
  const id = guideId(match[1] ?? "");
  if (!placements[id])
    throw new Error(
      `Guide link ${href} points to a page that does not exist. Pages: ${Object.keys(placements).join(", ")}.`,
    );
  return `/docs/${id}${match[2] ?? ""}`;
}

/**
 * Guide Markdown with its guide links rewritten to site routes, normalized to LF line endings.
 * Fenced code and inline code spans are left exactly as written.
 * @throws When a link names a guide file that is not a docs page.
 */
export function guideMarkdown(source: string): string {
  return scanLines(source)
    .map((line) => (line.code ? line.text : rewriteLine(line.text)))
    .join("\n");
}

/** Guide Markdown without its h1, normalized to LF line endings and trimmed. */
export function guideBody(source: string): string {
  const lines = scanLines(source);
  const titleAt = lines.findIndex(isTitle);
  return lines
    .filter((_, index) => index !== titleAt)
    .map((line) => line.text)
    .join("\n")
    .trim();
}

/** Splits the source into lines, marking fenced code. A byte-order mark and CRLF are dropped first. */
function scanLines(source: string): Line[] {
  const text = source.replace(BYTE_ORDER_MARK, "").replace(/\r\n?/g, "\n");
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence === undefined) {
      fence = marker;
      return { text: line, code: marker !== undefined };
    }
    const closes =
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker;
    if (closes) fence = undefined;
    return { text: line, code: true };
  });
}

function isTitle(line: Line): boolean {
  return !line.code && TITLE_LINE.test(line.text);
}

/** The first block after the title when it is a paragraph, joined onto one line. */
function firstParagraph(lines: readonly Line[]): string {
  const start = lines.findIndex((line) => line.text.trim() !== "");
  const first = lines[start];
  if (!first || first.code || first.text.trimStart().startsWith("#")) return "";
  const end = lines.findIndex(
    (line, index) => index > start && (line.code || line.text.trim() === ""),
  );
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.text.trim())
    .join(" ");
}

/** Plain text for a meta description, cut to the limit. */
function summarize(paragraph: string): string {
  const text = paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "");
  if (text.length <= DESCRIPTION_LIMIT) return text;
  return `${text.slice(0, DESCRIPTION_LIMIT - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** Rewrites the guide links on one prose line, skipping inline code spans. */
function rewriteLine(text: string): string {
  if (DEFINITION.test(text))
    return text.replace(DEFINITION, (_, lead, href) => lead + guideLink(href));
  let rewritten = "";
  let proseStart = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    rewritten +=
      rewriteInlineTargets(text.slice(proseStart, span.index)) + span[0];
    proseStart = span.index + span[0].length;
  }
  return rewritten + rewriteInlineTargets(text.slice(proseStart));
}

function rewriteInlineTargets(prose: string): string {
  return prose.replace(
    INLINE_TARGET,
    (_, lead: string, href: string) => lead + guideLink(href),
  );
}
