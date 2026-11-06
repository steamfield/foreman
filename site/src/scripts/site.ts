import { enhanceCopyButtons } from "@steamfield/ui/copy";
import { initReveal } from "@steamfield/ui/reveal";
import { track } from "../lib/analytics";
import { Events } from "../lib/events";

// The one module script the page loads besides its islands: copy buttons on
// server-rendered commands, section-view tracking and scroll entrances. Each part
// does nothing on a page without its markup.

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

setupCopyButtons();
setupSectionViews();
initReveal({ immediate: (el) => el.closest("[data-hero]") !== null });
