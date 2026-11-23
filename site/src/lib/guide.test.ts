// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  guideBody,
  guideData,
  guideId,
  guideLink,
  guideMarkdown,
} from "./guide";

const page = (title: string, paragraph: string) =>
  `# ${title}\n\n${paragraph}\n\n## Install\n\nRun it.\n`;

describe("guideId", () => {
  test.each([
    ["README.md", "overview"],
    ["providers.md", "providers"],
    ["how-it-works.md", "how-it-works"],
  ])("maps %s to %s", (file, id) => {
    expect(guideId(file)).toBe(id);
  });
});

describe("guideData", () => {
  test("takes the title from the h1 and the description from the first paragraph", () => {
    expect(
      guideData(
        "providers",
        page(
          "Providers and models",
          "How foreman picks [Codex](https://openai.com) or `agy` from the\n**model** you name.",
        ),
      ),
    ).toEqual({
      title: "Providers and models",
      description: "How foreman picks Codex or agy from the model you name.",
      group: "guides",
      order: 0,
    });
  });

  test("truncates a long description to 160 characters with an ellipsis", () => {
    const { description } = guideData("cli", page("CLI", "a".repeat(161)));
    expect(description).toBe(`${"a".repeat(157)}...`);
  });

  test("keeps a description of exactly 160 characters whole", () => {
    const paragraph = "a".repeat(160);
    expect(guideData("cli", page("CLI", paragraph)).description).toBe(
      paragraph,
    );
  });

  test.each([
    ["no h1", "## Only a section\n\nText.\n"],
    ["an empty file", ""],
    ["an h1 only inside fenced code", "```sh\n# comment\n```\n\nText.\n"],
  ])("throws naming the page when the file has %s", (_, body) => {
    expect(() => guideData("monitor", body)).toThrow(
      "Guide monitor needs a level-one title.",
    );
  });

  test.each([
    ["a section heading", "# Monitor\n\n## Keys\n\nText.\n"],
    ["a code block", "# Monitor\n\n```sh\nforeman monitor\n```\n"],
    ["nothing", "# Monitor\n"],
  ])(
    "throws when the title is followed by %s instead of a summary",
    (_, body) => {
      expect(() => guideData("monitor", body)).toThrow(
        "Guide monitor needs a summary paragraph after its title",
      );
    },
  );

  test("never takes a # comment inside fenced code as the title", () => {
    const body =
      "```sh\n# install\nnpm i -g foreman\n```\n\n# Getting started\n\nInstall it.\n";
    expect(guideData("getting-started", body).title).toBe("Getting started");
  });

  test("parses CRLF line endings and a byte-order mark like plain LF", () => {
    const lf = page("Configuration", "Where foreman keeps its config.");
    const crlf = `\uFEFF${lf.replaceAll("\n", "\r\n")}`;
    expect(guideData("configuration", crlf)).toEqual(
      guideData("configuration", lf),
    );
  });

  test("rejects a guide page that has no place in the sidebar, naming it", () => {
    expect(() => guideData("faq", page("FAQ", "Questions."))).toThrow(
      /Guide faq has no place in the docs sidebar/,
    );
  });

  test.each([
    ["overview", "getting-started", 0],
    ["getting-started", "getting-started", 1],
    ["repo-setup", "getting-started", 2],
    ["providers", "guides", 0],
    ["delegating", "guides", 1],
    ["monitor", "guides", 2],
    ["how-it-works", "guides", 3],
    ["cli", "reference", 0],
    ["configuration", "reference", 1],
  ])("places %s in %s at order %i", (id, group, order) => {
    expect(guideData(id, page("Title", "Text."))).toMatchObject({
      group,
      order,
    });
  });
});

describe("guideLink", () => {
  test.each([
    ["providers.md", "/docs/providers"],
    ["./cli.md#exit-codes", "/docs/cli#exit-codes"],
    ["README.md", "/docs/overview"],
    ["./README.md", "/docs/overview"],
    ["README.md#terms", "/docs/overview#terms"],
  ])("rewrites the guide link %s to %s", (href, route) => {
    expect(guideLink(href)).toBe(route);
  });

  test.each([
    "#exit-codes",
    "mailto:team@example.com",
    "https://github.com/steamfield/foreman/blob/main/README.md",
    "/docs/providers",
  ])("leaves %s unchanged", (href) => {
    expect(guideLink(href)).toBe(href);
  });

  test.each(["images/monitor.png", "../README.md", "../../src/cli.ts"])(
    "throws for the repository path %s, which does not resolve on the site",
    (href) => {
      expect(() => guideLink(href)).toThrow(
        /Link repo files with their GitHub URL/,
      );
    },
  );

  test("throws for a guide link to a page that does not exist", () => {
    expect(() => guideLink("./missing.md#top")).toThrow(
      /Guide link \.\/missing\.md#top points to a page that does not exist/,
    );
  });
});

describe("guideMarkdown", () => {
  test("rewrites inline and reference guide links outside code", () => {
    const source = [
      "See [providers](providers.md) and [exit codes](./cli.md#exit-codes).",
      "Read the [repo][setup] page and ![the monitor](/brand/foreman-icon.svg).",
      "Inline `[x](cli.md)` stays, as does [GitHub](https://github.com).",
      "",
      "[setup]: ./repo-setup.md",
    ].join("\n");
    expect(guideMarkdown(source)).toBe(
      [
        "See [providers](/docs/providers) and [exit codes](/docs/cli#exit-codes).",
        "Read the [repo][setup] page and ![the monitor](/brand/foreman-icon.svg).",
        "Inline `[x](cli.md)` stays, as does [GitHub](https://github.com).",
        "",
        "[setup]: /docs/repo-setup",
      ].join("\n"),
    );
  });

  test("leaves links inside fenced code untouched", () => {
    const source =
      "```md\n[providers](providers.md)\n[gone](missing.md)\n```\n\n~~~\n[x](cli.md)\n~~~\n";
    expect(guideMarkdown(source)).toBe(source);
  });

  test("throws for a link to a missing page", () => {
    expect(() => guideMarkdown("See [gone](gone.md).")).toThrow(/gone\.md/);
  });
});

describe("guideBody", () => {
  test("drops the h1 and keeps a # comment inside fenced code", () => {
    const source = "# Title\r\n\r\nText.\r\n\r\n```sh\r\n# comment\r\n```\r\n";
    expect(guideBody(source)).toBe("Text.\n\n```sh\n# comment\n```");
  });
});
