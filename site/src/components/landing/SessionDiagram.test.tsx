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
import { buildSession, sceneAt } from "../../data/session";
import { initAnalytics, resetAnalyticsForTests } from "../../lib/analytics";
import { PLAYBACK_RATE, SessionDiagram } from "./SessionDiagram";
import { SessionCanvas } from "./session/SessionCanvas";

const session = buildSession(loadRun("site-commands"), {
  "site-console": loadRun("site-console"),
  "site-commands": loadRun("site-commands"),
  "site-e2e": loadRun("site-e2e"),
});
const renderDemo = () => render(<SessionDiagram session={session} />);
// Tests speak in story time; the clock runs PLAYBACK_RATE times faster.
const advance = (ms: number) =>
  act(() => vi.advanceTimersByTimeAsync(ms / PLAYBACK_RATE));
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
  it.each(["wide", "tall"])(
    "keeps travelling labels clear of cards, including their final position, in the %s geometry",
    (geometry) => {
      const scene = sceneAt(session, session.stillAt);
      let visibleLabels = 0;
      for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1]) {
        const { container, unmount } = render(
          <SessionCanvas
            session={session}
            scene={{
              ...scene,
              packets: session.packets.map((packet) => ({
                ...packet,
                progress,
              })),
            }}
            playing={false}
          />,
        );
        const drawing = container.querySelector(`.session-${geometry}`);
        const box = (element: Element) => ({
          x: Number(element.getAttribute("x")),
          y: Number(element.getAttribute("y")),
          w: Number(element.getAttribute("width")),
          h: Number(element.getAttribute("height")),
        });
        const cards = [
          ...(drawing?.querySelectorAll("[data-session-card]") ?? []),
        ].map(box);
        expect(cards).toHaveLength(5);
        const labels = drawing?.querySelectorAll("[data-packet-label]") ?? [];
        if (progress === 0.5 || (geometry === "wide" && progress === 0.75)) {
          const question = drawing?.querySelector(
            '[data-packet-label="ask_orchestrator"]',
          );
          expect(question).not.toBeNull();
          expect(question?.parentElement).toHaveAttribute("opacity", "1");
        }
        visibleLabels += labels.length;
        for (const label of labels) {
          const a = box(label);
          for (const b of cards) {
            expect(
              a.x < b.x + b.w &&
                a.x + a.w > b.x &&
                a.y < b.y + b.h &&
                a.y + a.h > b.y,
              `${label.getAttribute("data-packet-label")} at ${progress}`,
            ).toBe(false);
          }
        }
        if (progress === 1) expect(labels).toHaveLength(0);
        unmount();
      }
      expect(visibleLabels).toBeGreaterThan(0);
    },
  );

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

  it("animates active cards and busy links only during playback", async () => {
    renderDemo();
    await advance(12_000);
    const svg = document.querySelector("svg");
    expect(svg).toHaveAttribute("data-playing");
    const activity = (name: string) =>
      document
        .querySelector(`.session-wide [data-session-card="${name}"]`)
        ?.getAttribute("data-activity");
    expect(session.delegates.map((d) => activity(d.name))).toEqual([
      "running",
      "running",
      "running",
    ]);
    expect(activity("claude")).toBe("idle");
    expect(
      document.querySelectorAll(".session-wide .session-trace"),
    ).toHaveLength(3);
    expect(
      document.querySelectorAll(".session-wide [data-link-busy]").length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(svg).not.toHaveAttribute("data-playing");
    expect(document.querySelectorAll(".session-trace")).toHaveLength(0);
    expect(document.querySelectorAll("[data-link-busy]")).toHaveLength(0);
    expect(activity("site-console")).toBe("running");
  });

  it("marks the question as waiting activity in the still frame without motion", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <SessionDiagram session={session} />,
    );
    expect(
      document
        .querySelector('.session-wide [data-session-card="site-commands"]')
        ?.getAttribute("data-activity"),
    ).toBe("waiting");
    expect(document.querySelector("svg")).not.toHaveAttribute("data-playing");
    expect(document.querySelectorAll(".session-trace")).toHaveLength(0);
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
    expect(document.querySelector("svg")?.textContent).toContain("gpt-astra");
    expect(
      screen.getByText(
        /Each lane's commands are sampled from its delegate's recording/,
      ),
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
