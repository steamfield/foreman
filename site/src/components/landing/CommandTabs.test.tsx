import { createConsentStore } from "@steamfield/ui/consent";
import { enhanceCopyButtons } from "@steamfield/ui/copy";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { PostHog, type CaptureResult } from "posthog-js";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../../data/commands";
import { initAnalytics, resetAnalyticsForTests } from "../../lib/analytics";
import { CommandTabs } from "./CommandTabs";

const commands = loadCommands();

afterEach(() => {
  resetAnalyticsForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CommandTabs", () => {
  it("hydrates cleanly when the page's copy enhancer runs before this visible island", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<CommandTabs commands={commands} />);
    document.body.append(container);
    const dispose = enhanceCopyButtons(container);
    const error = vi.spyOn(console, "error");
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <CommandTabs commands={commands} />);
      });
      expect(error).not.toHaveBeenCalled();
      expect(
        within(container).getAllByRole("button", { name: "Copy command" }),
      ).toHaveLength(1);
    } finally {
      await act(async () => root?.unmount());
      dispose();
      container.remove();
    }
  });

  it("server-renders every complete recording as a stacked console with no dead copy buttons", () => {
    const html = renderToStaticMarkup(<CommandTabs commands={commands} />);
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(
      commands.length,
    );
    expect(container.querySelector("[data-live]")).toBeNull();
    for (const command of commands) {
      const panel = container.querySelector(`#command-${command.name}`);
      expect(panel).not.toHaveAttribute("hidden");
      expect(panel?.querySelector("pre code")?.textContent).toBe(
        command.output,
      );
      expect(
        panel?.querySelector(`#command-line-${command.name}`)?.textContent,
      ).toBe(command.command);
      expect(panel?.querySelector("button")).toBeNull();
      expect(
        container.querySelector(`a[href="#command-${command.name}"]`),
      ).toHaveTextContent(command.caption);
    }
    expect(container).toHaveTextContent(
      "Command captions are written for this page",
    );
  });

  it("switches instantly by click and horizontal keyboard navigation, announcing only the selection", () => {
    const media = window.matchMedia("(min-width: 1024px)");
    Object.defineProperty(media, "matches", { value: false });
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    render(<CommandTabs commands={commands} />);
    fireEvent.click(screen.getByRole("tab", { name: /^doctor / }));
    expect(
      screen.getByRole("tabpanel").querySelector("pre code")?.textContent,
    ).toBe(commands.find((command) => command.name === "doctor")?.output);
    expect(screen.getByText("doctor output shown.")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    const doctor = screen.getByRole("tab", { name: /^doctor / });
    doctor.focus();
    fireEvent.keyDown(doctor, { key: "Home" });
    expect(screen.getAllByRole("tab")[0]).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "id",
      `command-${commands[0]?.name}`,
    );
    fireEvent.keyDown(document.activeElement ?? doctor, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[1]).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "id",
      `command-${commands[1]?.name}`,
    );
    expect(
      screen.getByRole("tabpanel").querySelector("pre"),
    ).not.toHaveAttribute("aria-live");
  });

  it("uses vertical keyboard navigation at desktop widths", () => {
    const media = window.matchMedia("(min-width: 1024px)");
    Object.defineProperty(media, "matches", { value: true });
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    render(<CommandTabs commands={commands} />);
    const tabs = screen.getAllByRole("tab");
    expect(screen.getByRole("tablist")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
    tabs[0]?.focus();
    fireEvent.keyDown(tabs[0] ?? document.body, { key: "ArrowDown" });
    expect(tabs[1]).toHaveFocus();
  });

  it("copies the exact recorded command through the library control", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    render(<CommandTabs commands={commands} />);
    fireEvent.click(screen.getByRole("tab", { name: /^doctor / }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("tabpanel")).getByRole("button", {
          name: "Copy command",
        }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(
      commands.find((command) => command.name === "doctor")?.command,
    );
    expect(
      within(screen.getByRole("tabpanel")).getByRole("status"),
    ).toHaveTextContent("Copied to clipboard.");
  });

  it("tracks reader selections once without tracking the initial render", async () => {
    const consent = createConsentStore({ domain: "steamfield.io" });
    const sdk = new PostHog();
    const seen: CaptureResult[] = [];
    const init = sdk.init.bind(sdk);
    vi.spyOn(sdk, "init").mockImplementation((key, config) =>
      init(key, {
        ...config,
        advanced_disable_flags: true,
        opt_out_useragent_filter: true,
        before_send: (event) => {
          seen.push(event);
          return null;
        },
      }),
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      await initAnalytics({ key: "phc_command_tabs", consent }, async () => ({
        default: sdk,
      }));
      render(<CommandTabs commands={commands} />);
      expect(seen.filter((event) => event.event === "command_tab")).toEqual([]);
      fireEvent.click(screen.getByRole("tab", { name: /^doctor / }));
      fireEvent.click(screen.getByRole("tab", { name: /^doctor / }));
      expect(
        seen
          .filter((event) => event.event === "command_tab")
          .map((event) => event.properties.name),
      ).toEqual(["doctor"]);
    } finally {
      consent.destroy();
    }
  });

  it("shows complete reference output under reduced motion and renders nothing for an empty reference", () => {
    document.documentElement.dataset.sfMotion = "reduce";
    try {
      const { unmount } = render(<CommandTabs commands={commands} />);
      expect(
        screen.getByRole("tabpanel").querySelector("pre code")?.textContent,
      ).toBe(commands[0]?.output);
      unmount();
      const { container } = render(<CommandTabs commands={[]} />);
      expect(container).toBeEmptyDOMElement();
    } finally {
      delete document.documentElement.dataset.sfMotion;
    }
  });
});
