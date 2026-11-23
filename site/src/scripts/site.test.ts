// The page script's docs behavior. site.ts sets everything up when it is imported, so each
// test builds the DOM first and then imports a fresh copy of the module. The Clipboard API and
// fetch are browser boundaries, replaced per test.
import { fireEvent, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, test, vi } from "vitest";

const copyPage =
  '<button type="button" hidden data-copy-page="/docs/cli.md">Copy page</button>';

/** Replaces navigator.clipboard for one test, or removes it when `writeText` is undefined. */
function stubClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

async function load(html: string) {
  document.body.innerHTML = html;
  vi.resetModules();
  await import("./site");
}

const copied: string[] = [];
const recordCopy = async (text: string) => {
  copied.push(text);
};

afterEach(() => {
  copied.length = 0;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.innerHTML = "";
});

describe("copy page", () => {
  test("stays hidden when the Clipboard API is unavailable", async () => {
    stubClipboard(undefined);
    await load(copyPage);
    expect(document.querySelector("button")?.hidden).toBe(true);
  });

  test("copies the page's Markdown export and says Copied", async () => {
    stubClipboard(recordCopy);
    vi.stubGlobal("fetch", async (href: string) =>
      href === "/docs/cli.md"
        ? new Response("# Command reference\n")
        : new Response("", { status: 404 }),
    );
    await load(copyPage);
    const button = document.querySelector("button") as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Copied"));
    expect(copied).toEqual(["# Command reference\n"]);
  });

  test("says Copy failed when the export cannot be fetched", async () => {
    stubClipboard(recordCopy);
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    await load(copyPage);
    const button = document.querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Copy failed"));
    expect(copied).toEqual([]);
  });
});

describe("inline code copy", () => {
  const article = `<article data-docs-article><div class="prose">
    <p>Run <code>foreman doctor</code> first.</p>
    <pre><code>foreman start demo</code></pre>
    <p><a href="/docs/cli"><code>foreman wait</code></a></p>
  </div></article>`;

  test("copies an inline code pill and announces it", async () => {
    stubClipboard(recordCopy);
    await load(article);
    fireEvent.click(document.querySelector("p code") as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[role="status"]')).toHaveTextContent(
        "Copied",
      ),
    );
    expect(copied).toEqual(["foreman doctor"]);
  });

  test("leaves code blocks and linked pills alone", async () => {
    stubClipboard(recordCopy);
    await load(article);
    fireEvent.click(document.querySelector("pre code") as HTMLElement);
    fireEvent.click(document.querySelector("a code") as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copied).toEqual([]);
  });

  test("is off when the Clipboard API is unavailable", async () => {
    stubClipboard(undefined);
    await load(article);
    expect(
      document
        .querySelector("[data-docs-article]")
        ?.hasAttribute("data-copy-inline"),
    ).toBe(false);
  });
});
