import { enhanceCopyButtons } from "@steamfield/ui/copy";
import { spyToc } from "@steamfield/ui/docs";
import { initReveal } from "@steamfield/ui/reveal";
import { track } from "../lib/analytics";
import { Events } from "../lib/events";

// The one module script every page loads besides its islands: copy buttons on
// server-rendered commands, section-view tracking, scroll entrances, and the docs
// page's Copy page button, outline highlight and inline-code copy. Each part does
// nothing on a page without its markup.

/** Copy buttons rendered by CopyCommand. `data-install-copy` on a wrapper names the method. */
function setupCopyButtons() {
  enhanceCopyButtons(document, {
    copiedMs: 1500,
    onCopy: ({ id, ok }) => {
      if (!ok) return;
      const wrapper = document
        .getElementById(id)
        ?.closest<HTMLElement>("[data-install-copy]");
      const method = wrapper?.dataset.installCopy;
      if (method) track(Events.installCopied, { method });
    },
  });
}

/** Sends section_viewed once per [data-track-section] that scrolls into view. */
function setupSectionViews() {
  const sections = document.querySelectorAll<HTMLElement>(
    "[data-track-section]",
  );
  if (sections.length === 0 || typeof IntersectionObserver === "undefined")
    return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = (entry.target as HTMLElement).dataset.trackSection;
        if (id) track(Events.sectionViewed, { id });
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.3 },
  );
  for (const section of sections) observer.observe(section);
}

const canCopy = () => typeof navigator.clipboard?.writeText === "function";

/** How long a docs copy control says "Copied" or "Copy failed". */
const FEEDBACK_MS = 1500;

/**
 * The docs "Copy page" button fetches the page's Markdown export and copies it. It stays
 * hidden without the Clipboard API, since there would be nothing for it to do. A failed
 * fetch or write is reported on the button itself.
 */
function setupCopyPage() {
  const button = document.querySelector<HTMLButtonElement>("[data-copy-page]");
  const href = button?.dataset.copyPage;
  if (!button || !href || !canCopy()) return;
  button.hidden = false;
  const label = button.textContent;
  const copyMarkdown = async () => {
    const response = await fetch(href);
    if (!response.ok)
      throw new Error(`GET ${href} returned ${response.status}`);
    await navigator.clipboard.writeText(await response.text());
  };
  button.addEventListener("click", () => {
    copyMarkdown()
      .then(
        () => (button.textContent = "Copied"),
        () => (button.textContent = "Copy failed"),
      )
      .finally(() =>
        setTimeout(() => {
          button.textContent = label;
        }, FEEDBACK_MS),
      );
  });
}

/** Marks the outline link of the section being read with aria-current="location". */
function setupTocHighlight() {
  // One spy per list: the docs sidebar and its mobile menu carry the same hashes, and a spy
  // keeps one link per hash.
  for (const list of document.querySelectorAll("[data-toc]")) {
    spyToc(list, { linkSelector: "a[href^='#']" });
  }
}

/**
 * Click an inline code pill in a docs article to copy its text. Code blocks, linked pills and
 * headings are left alone, and so is a click that ends a text selection. One reused tooltip
 * shows the outcome and a polite live region announces it.
 */
function setupInlineCodeCopy() {
  const article = document.querySelector<HTMLElement>("[data-docs-article]");
  if (!article || !canCopy()) return;
  article.dataset.copyInline = "";
  const tip = document.createElement("div");
  tip.className = "copy-tip";
  tip.setAttribute("aria-hidden", "true");
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("role", "status");
  document.body.append(tip, live);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const showOutcome = (code: HTMLElement, message: string) => {
    clearTimeout(hideTimer);
    const box = code.getBoundingClientRect();
    tip.style.left = `${box.left + box.width / 2 + window.scrollX}px`;
    tip.style.top = `${box.top + window.scrollY}px`;
    tip.textContent = message;
    tip.dataset.visible = "";
    live.textContent = message;
    hideTimer = setTimeout(() => {
      delete tip.dataset.visible;
      live.textContent = "";
    }, FEEDBACK_MS);
  };

  article.addEventListener("click", (event) => {
    const code =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".prose code")
        : null;
    if (!code || code.closest("pre, a, h1, h2, h3, h4, h5, h6")) return;
    if (!window.getSelection()?.isCollapsed) return;
    navigator.clipboard.writeText(code.textContent ?? "").then(
      () => showOutcome(code, "Copied"),
      () => showOutcome(code, "Copy failed"),
    );
  });
}

setupCopyButtons();
setupSectionViews();
setupCopyPage();
setupTocHighlight();
setupInlineCodeCopy();
initReveal({ immediate: (el) => el.closest("[data-hero]") !== null });
