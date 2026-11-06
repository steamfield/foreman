import { act, cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTimelines } from "../../data/evidence";
import { ParallelRuns, QuestionTimeline, WorkOrder } from "./evidence";
import { loadRun, releaseRuns } from "../../data/runs";
import { handoff, parallel } from "../../data/landing";

const run = loadRun("fix-supervisor");
const handoffRun = loadRun("site-console");
const timeline = runTimelines(releaseRuns);

describe("work order", () => {
  it("renders the contract excerpt, the unmodified digest and the note", () => {
    const { container } = render(
      <WorkOrder run={handoffRun} note={handoff.note} />,
    );
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      handoffRun.contract.split("\n")[0] ?? "",
    );
    expect(
      screen.getByText("May change", { exact: true, selector: "span" }),
    ).toBeVisible();
    expect(screen.getAllByLabelText("Excerpt omitted")).toHaveLength(2);
    expect(screen.getByText(`foreman status ${handoffRun.name}`)).toBeVisible();
    expect(container.querySelector("figure code")?.textContent).toBe(
      handoffRun.digest,
    );
    expect(handoffRun.digest).toContain("outside May change:  (none)");
    expect(screen.getByText(/stayed inside its list/)).toBeVisible();
  });

  it("server-renders a native disclosure containing the complete contract", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <WorkOrder run={handoffRun} note={handoff.note} />,
    );
    const details = container.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe(
      "Read the full contract",
    );
    expect(details?.querySelector("pre")?.textContent).toBe(
      handoffRun.contract,
    );
    expect(details?.open).toBe(false);
  });
});

describe("question timeline", () => {
  it("renders both complete exchanges, their offsets and the preceding hook feedback", () => {
    const { container } = render(<QuestionTimeline run={run} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(
      [...container.querySelectorAll("blockquote")].map(
        (node) => node.textContent,
      ),
    ).toEqual(
      run.questions.map((q) => (q._tag === "Asked" ? q.question : q.text)),
    );
    expect(screen.getByText("+20:21 · Codex asks q1")).toBeVisible();
    expect(screen.getByText("+39:16 · Codex asks q2")).toBeVisible();
    expect(screen.getByText(/answered by Claude · 19s later/)).toBeVisible();
    expect(
      screen.getByText(
        /auto-answered by foreman after the timeout · 15m00s later/,
      ),
    ).toBeVisible();
    const hook = run.events.find((event) => event.kind === "hook-blocked");
    expect(container.querySelector("figure code")?.textContent).toBe(
      hook?.kind === "hook-blocked" ? hook.feedback : undefined,
    );
    const second = screen.getAllByRole("listitem")[1];
    expect(second?.textContent?.indexOf("hook-blocked")).toBeLessThan(
      second?.textContent?.indexOf("Codex asks q2") ?? 0,
    );
  });

  it("server-renders every question and answer without playback or JavaScript", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<QuestionTimeline run={run} />);
    expect(
      [...container.querySelectorAll("blockquote")].map(
        (node) => node.textContent,
      ),
    ).toEqual(
      run.questions.map((q) => (q._tag === "Asked" ? q.question : q.text)),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("parallel runs", () => {
  it("provides an accessible table with each run's recorded figures", () => {
    render(<ParallelRuns timeline={timeline} />);
    const table = screen.getByRole("table", {
      name: "Parallel release runs, measured from the earliest start",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        [...row.querySelectorAll("th,td")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      [
        "fix-cli",
        "+00:17",
        "+25:03",
        "24m46s",
        "180 (27 failed)",
        "25",
        "65.2K",
        "None",
      ],
      [
        "fix-daemon",
        "+00:00",
        "+25:59",
        "25m59s",
        "232 (43 failed)",
        "12",
        "57.3K",
        "None",
      ],
      [
        "fix-supervisor",
        "+00:03",
        "+1:10:34",
        "70m30s",
        "299 (34 failed)",
        "18",
        "174.8K",
        "q1 at +20:25, q2 at +39:19",
      ],
      [
        "fix-worktrees",
        "+00:10",
        "+29:12",
        "29m01s",
        "186 (23 failed)",
        "15",
        "69.0K",
        "None",
      ],
    ]);
    expect(screen.getByText(parallel.caption)).toBeVisible();
    expect(screen.getByText(run.baseCommit)).toBeVisible();
    expect(screen.getByText("foreman wait --all")).toBeVisible();
  });

  it("server-renders the chart and accessible figures in their final state", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ParallelRuns timeline={timeline} />,
    );
    expect(
      within(container).getByRole("table").querySelectorAll("tbody tr"),
    ).toHaveLength(4);
    expect(container.textContent).toContain("70m30s");
    expect(container.textContent).toContain("Codex asked a question");
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("parallel runs replay", () => {
  // The replay compresses the shared axis into 14 seconds of wall clock.
  const advanceAxis = (ms: number) =>
    act(() => vi.advanceTimersByTimeAsync((ms / timeline.extentMs) * 14_000));
  const chart = () =>
    document.querySelector('[aria-hidden="true"]')?.textContent ?? "";
  const bars = () =>
    [...document.querySelectorAll("[data-parallel-bar]")].map((bar) => ({
      state: bar.getAttribute("data-parallel-bar"),
      live: bar.classList.contains("parallel-live"),
    }));
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("grows the bars, ticks the counters and pulses a pending question", async () => {
    render(<ParallelRuns timeline={timeline} />);
    await advanceAxis(600_000);
    expect(bars()).toEqual(
      Array.from({ length: 4 }, () => ({ state: "running", live: true })),
    );
    expect(chart()).not.toContain("70m30s");
    expect(document.querySelectorAll(".bg-signal.-top-1")).toHaveLength(0);
    // q2 holds fix-supervisor from about +39:20 to +54:20.
    await advanceAxis(1_900_000);
    expect(bars().map((bar) => bar.state)).toEqual([
      "done",
      "done",
      "waiting",
      "done",
    ]);
    expect(document.querySelectorAll(".bg-signal.-top-1")).toHaveLength(2);
    expect(document.querySelectorAll(".state-waiting")).toHaveLength(1);
    await advanceAxis(timeline.extentMs);
    expect(bars()).toEqual(
      Array.from({ length: 4 }, () => ({ state: "done", live: false })),
    );
    expect(chart()).toContain("70m30s");
    expect(chart()).toContain("299 / 34");
    expect(document.querySelectorAll(".state-waiting")).toHaveLength(0);
  });

  it("shows the recorded totals at once under reduced motion", async () => {
    reduceMotion(true);
    render(<ParallelRuns timeline={timeline} />);
    await advanceAxis(600_000);
    expect(bars().every((bar) => bar.state === "done" && !bar.live)).toBe(true);
    expect(chart()).toContain("70m30s");
  });
});
