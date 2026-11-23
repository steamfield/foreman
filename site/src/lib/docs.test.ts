// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DocData } from "../content/schema";
import {
  commandName,
  type DocEntry,
  docHref,
  docsNav,
  llmsFull,
  markdownHref,
  outline,
  pageLinks,
  toMarkdownExport,
} from "./docs";

const groups = [
  { id: "getting-started", label: "Getting started" },
  { id: "guides", label: "Guides" },
  { id: "reference", label: "Reference" },
] as const;

function entry(
  id: string,
  group: DocData["group"],
  order: number,
  title = id,
): DocEntry {
  return {
    id,
    data: { title, description: `About ${title}.`, group, order },
    body: `# ${title}\n\nAbout ${title}.\n\n## Usage\n\nSee [the CLI](cli.md).\n`,
  };
}

const entries = [
  entry("cli", "reference", 0, "Command reference"),
  entry("monitor", "guides", 2, "Watching runs"),
  entry("delegating", "guides", 1, "Delegating"),
  entry("zeta", "guides", 1, "Alpha tie"),
  entry("overview", "getting-started", 0, "foreman"),
];

test("routes have no trailing slash", () => {
  expect(docHref("providers")).toBe("/docs/providers");
  expect(markdownHref("providers")).toBe("/docs/providers.md");
});

describe("docsNav", () => {
  test("lists groups in config order, pages by order then title, and drops empty groups", () => {
    const nav = docsNav(
      entries.filter((page) => page.data.group !== "reference"),
      groups,
    );
    expect(
      nav.map((group) => [group.label, group.items.map((item) => item.id)]),
    ).toEqual([
      ["Getting started", ["overview"]],
      ["Guides", ["zeta", "delegating", "monitor"]],
    ]);
    expect(nav[0]?.items[0]).toEqual({
      id: "overview",
      title: "foreman",
      description: "About foreman.",
    });
  });
});

describe("pageLinks", () => {
  const nav = docsNav(entries, groups);

  test("crosses group boundaries", () => {
    expect(pageLinks(nav, "overview").next?.id).toBe("zeta");
    expect(pageLinks(nav, "cli").prev?.id).toBe("monitor");
  });

  test("returns undefined past either end", () => {
    expect(pageLinks(nav, "overview").prev).toBeUndefined();
    expect(pageLinks(nav, "cli").next).toBeUndefined();
  });
});

describe("toMarkdownExport", () => {
  test("starts with the title and description, drops the source h1 and rewrites guide links", () => {
    expect(
      toMarkdownExport(entry("monitor", "guides", 2, "Watching runs")),
    ).toBe(
      "# Watching runs\n\n> About Watching runs.\n\nAbout Watching runs.\n\n## Usage\n\nSee [the CLI](/docs/cli).\n",
    );
  });
});

test("llmsFull lists every page's export in sidebar order", () => {
  const text = llmsFull(
    { title: "foreman", description: "Delegate tasks." },
    docsNav(entries, groups),
    entries,
  );
  expect(text.startsWith("# foreman\n\n> Delegate tasks.\n\n")).toBe(true);
  const titles = Array.from(text.matchAll(/^# (.+)$/gm), (match) => match[1]);
  expect(titles).toEqual([
    "foreman",
    "foreman",
    "Alpha tie",
    "Delegating",
    "Watching runs",
    "Command reference",
  ]);
});

describe("commandName", () => {
  test.each([
    ["foreman start <name> --contract <file>", "foreman start"],
    ["foreman wait --all", "foreman wait"],
    ["foreman status [<name>]", "foreman status"],
    ["foreman doctor", "foreman doctor"],
  ])("reads %s as %s", (signature, name) => {
    expect(commandName(signature)).toBe(name);
  });
});

describe("outline", () => {
  test("lists only h2s and labels a code-only h2 with its command name", () => {
    const body =
      "# CLI\r\n\r\n## Exit codes\r\n\r\n### Detail\r\n\r\n## `foreman start <name>`\r\n";
    expect(
      outline(
        [
          { depth: 2, slug: "exit-codes", text: "Exit codes" },
          { depth: 3, slug: "detail", text: "Detail" },
          {
            depth: 2,
            slug: "foreman-start-name",
            text: "foreman start <name>",
          },
        ],
        body,
      ),
    ).toEqual([
      { slug: "exit-codes", label: "Exit codes", code: false },
      { slug: "foreman-start-name", label: "foreman start", code: true },
    ]);
  });
});
