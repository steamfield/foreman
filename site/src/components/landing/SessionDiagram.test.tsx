import { createConsentStore } from "@steamfield/ui/consent";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { PostHog, type CaptureResult } from "posthog-js";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRun } from "../../data/runs";
import { buildSession } from "../../data/session";
import { initAnalytics, resetAnalyticsForTests } from "../../lib/analytics";
import { SessionDiagram } from "./SessionDiagram";

const session = buildSession(loadRun("site-commands"));
const renderDemo = () => render(<SessionDiagram session={session} />);
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
function reduceMotion(reduced: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", undefined);
  reduceMotion(false);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-sf-motion");
  resetAnalyticsForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SessionDiagram", () => {
  it("pauses when the digest opens and keeps its contents and focus while reading", async () => {
    renderDemo();
    await advance(34_000);
    const summary = screen.getByText("Read the recorded digest");
    summary.focus();
    fireEvent.click(summary);
    await advance(10_000);
    expect(screen.getByText(/Step 7 of 10/)).toBeInTheDocument();
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(summary).toHaveFocus();
    expect(summary.closest("details")?.querySelector("pre")?.textContent).toBe(
      loadRun("site-console").digest,
    );
  });

  it("pulses the waiting squares only during active playback", async () => {
    renderDemo();
    await advance(19_000);
    expect(document.querySelectorAll("svg .state-waiting")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(document.querySelectorAll("svg .state-waiting")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(document.querySelectorAll("svg .state-waiting")).toHaveLength(4);
  });

  it("server-renders the pending question, both recorded texts and all ten static steps", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <SessionDiagram session={session} />,
    );
    expect(screen.getByText(/Step 4 of 10/)).toBeInTheDocument();
    expect(screen.getByText(session.question.text)).toBeInTheDocument();
    expect(screen.getByText(session.question.answer)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelectorAll("svg .state-waiting")).toHaveLength(0);
    expect(document.querySelectorAll("svg")).toHaveLength(1);
    expect(document.querySelector("svg")?.textContent).toContain(
      "Held call · site-commands · q1",
    );
    expect(document.querySelector("svg")?.textContent).toContain("gpt-6-astra");
    expect(
      screen.getByText(/reuses site-commands' recorded checks/),
    ).toBeInTheDocument();
  });

  it("advances, pauses, resumes, and ends on archived worktrees", async () => {
    renderDemo();
    expect(screen.getByText(/Step 1 of 10/)).toBeInTheDocument();
    await advance(12_000);
    expect(screen.getByText(/Step 3 of 10/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await advance(8000);
    expect(screen.getByText(/Step 3 of 10/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await advance(7000);
    expect(screen.getByText(session.question.text)).toBeInTheDocument();
    await advance(40_000);
    expect(screen.getByText(/Step 10 of 10/)).toBeInTheDocument();
    expect(document.querySelector("svg")?.textContent).toContain(
      "Worktree removed",
    );
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("selects steps, keeps them paused for reading, and replays from the beginning", async () => {
    renderDemo();
    fireEvent.click(
      screen.getByRole("button", { name: "4. Hold a question for Claude" }),
    );
    expect(screen.getByText(session.question.text)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "4. Hold a question for Claude" }),
    ).toHaveAttribute("aria-current", "step");
    await advance(30_000);
    expect(screen.getByText(/Step 4 of 10/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "5. Answer and resume waiting" }),
    );
    expect(screen.getByText(session.question.answer)).toBeInTheDocument();
    expect(document.querySelector("svg")?.textContent).toContain(
      "Held call · empty",
    );
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByText(/Step 1 of 10/)).toBeInTheDocument();
    await advance(5000);
    expect(screen.getByText(/Step 2 of 10/)).toBeInTheDocument();
  });

  it.each(["preference", "attribute"])(
    "keeps the complete static story under reduced motion via %s",
    async (mode) => {
      if (mode === "preference") reduceMotion(true);
      else document.documentElement.setAttribute("data-sf-motion", "reduce");
      renderDemo();
      await advance(60_000);
      expect(screen.getByText(/Step 4 of 10/)).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(10);
      expect(screen.getByText(session.question.text)).toBeInTheDocument();
      expect(screen.getByText(session.question.answer)).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
      expect(document.querySelectorAll("svg .state-waiting")).toHaveLength(0);
    },
  );

  it("does not start off screen and holds its position when the diagram leaves view", async () => {
    let change: ((visible: boolean) => void) | undefined;
    class Observer {
      target: Element = document.body;
      constructor(callback: IntersectionObserverCallback) {
        change = (visible) =>
          callback(
            [
              {
                isIntersecting: visible,
                intersectionRatio: visible ? 1 : 0,
                target: this.target,
                time: 0,
                boundingClientRect: document.body.getBoundingClientRect(),
                intersectionRect: document.body.getBoundingClientRect(),
                rootBounds: null,
              },
            ],
            this,
          );
      }
      root = null;
      rootMargin = "0px";
      scrollMargin = "0px";
      thresholds = [0.15];
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    renderDemo();
    await advance(8000);
    expect(screen.getByText(/Step 1 of 10/)).toBeInTheDocument();
    act(() => change?.(true));
    await advance(12_000);
    expect(screen.getByText(/Step 3 of 10/)).toBeInTheDocument();
    act(() => change?.(false));
    await advance(12_000);
    expect(screen.getByText(/Step 3 of 10/)).toBeInTheDocument();
    act(() => change?.(true));
    await advance(7000);
    expect(screen.getByText(/Step 4 of 10/)).toBeInTheDocument();
  });

  it("hydrates its static frame without replacing mismatched markup", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SessionDiagram session={session} />);
    document.body.append(container);
    const errors: unknown[] = [];
    const root = await act(async () =>
      hydrateRoot(container, <SessionDiagram session={session} />, {
        onRecoverableError: (error) => errors.push(error),
      }),
    );
    expect(errors).toEqual([]);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    act(() => root.unmount());
    container.remove();
  });

  it("sends one session replay event through the real analytics boundary", async () => {
    const sdk = new PostHog();
    const seen: CaptureResult[] = [];
    const init = sdk.init.bind(sdk);
    vi.spyOn(sdk, "init").mockImplementation((key, config) =>
      init(key, {
        ...config,
        opt_out_useragent_filter: true,
        advanced_disable_flags: true,
        before_send: (event) => {
          if (event) seen.push(event);
          return null;
        },
      }),
    );
    const consent = createConsentStore();
    await initAnalytics(
      { key: "phc_session_test", host: "http://127.0.0.1:9", consent },
      async () => ({ default: sdk }),
    );
    renderDemo();
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    const replays = seen.filter((event) => event.event === "demo_replayed");
    expect(replays).toHaveLength(1);
    expect(replays[0]?.properties.id).toBe("session");
    consent.destroy();
  });
});
