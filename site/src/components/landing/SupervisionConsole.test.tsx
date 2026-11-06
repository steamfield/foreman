import {
  act,
  fireEvent,
  render,
  screen,
  within,
  cleanup,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRun } from "../../data/runs";
import { buildConsoleScript, runToPlayback } from "../../data/supervision";
import { hero } from "../../data/landing";
import { SupervisionConsole } from "./SupervisionConsole";

const run = loadRun("fix-supervisor");
const script = buildConsoleScript(run);

describe("SupervisionConsole", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // happy-dom does not calculate intersections. The library's documented
    // no-observer fallback counts the element as visible.
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
  });
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-sf-motion");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("server-renders the whole story, exact answers, final totals and both questions without controls", () => {
    const markup = renderToStaticMarkup(<SupervisionConsole script={script} />);
    const container = document.createElement("div");
    container.innerHTML = markup;
    const view = within(container);
    expect(view.queryByRole("button")).toBeNull();
    const claude = view.getByRole("region", { name: "Claude conversation" });
    expect(claude).toHaveTextContent("Fix part B of the release findings");
    expect(claude).toHaveTextContent(
      "I’ll read the hand-off, review the diff and run the checks before committing.",
    );
    for (const question of run.questions) {
      expect(claude.textContent).toContain(
        question._tag === "Asked" ? question.question : question.text,
      );
    }
    expect(view.getByLabelText("Codex: fix-supervisor")).toHaveTextContent(
      "299 commands (34 failed)",
    );
    expect(view.getByLabelText("Codex: fix-supervisor")).toHaveTextContent(
      "18 files written",
    );
    expect(view.getByLabelText("Codex: fix-supervisor")).toHaveTextContent(
      "37.4M in / 174.8K out",
    );
    expect(view.getByLabelText("Codex: fix-supervisor")).toHaveTextContent(
      "70m30s",
    );
    const feed = view.getByRole("region", { name: "Recorded Codex events" });
    expect(feed).toHaveTextContent("question q1");
    expect(feed).toHaveTextContent("question q2");
    expect(feed).toHaveTextContent("running → idle");
    expect(container).toHaveTextContent(hero.consoleCaption);
  });

  it("shows the finished story statically with the motion override and permits reading the full answer", () => {
    document.documentElement.setAttribute("data-sf-motion", "reduce");
    render(<SupervisionConsole script={script} />);
    expect(screen.queryByRole("button", { name: "Replay" })).toBeNull();
    expect(screen.getByLabelText("Codex: fix-supervisor")).toHaveTextContent(
      "37.4M in / 174.8K out",
    );
    const show = screen.getByRole("button", {
      name: "Show all recorded answer",
    });
    fireEvent.click(show);
    expect(
      screen.getByRole("button", { name: "Show less recorded answer" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("names successful and failed command results for assistive technology", async () => {
    const failed = script.events.find(
      (event) => event.kind === "command" && event.exitCode === 1,
    );
    if (!failed) throw new Error("Missing recorded failed command");
    render(<SupervisionConsole script={script} />);
    await act(() =>
      vi.advanceTimersByTimeAsync(
        runToPlayback(script.timeline, failed.t) + 32,
      ),
    );
    const feed = within(
      screen.getByRole("region", { name: "Recorded Codex events" }),
    );
    expect(feed.getAllByRole("img", { name: "exit 0" }).length).toBeGreaterThan(
      0,
    );
    expect(feed.getByRole("img", { name: "exit 1" })).toBeInTheDocument();
  });

  it("follows both question exchanges on one clock, pauses, finishes and replays", async () => {
    render(<SupervisionConsole script={script} />);
    const claude = screen.getByRole("region", { name: "Claude conversation" });
    const codex = screen.getByLabelText("Codex: fix-supervisor");
    const live = document.querySelector('[aria-live="polite"]');
    expect(claude).toHaveTextContent("background");
    expect(claude).not.toHaveTextContent("question q1");
    expect(codex).not.toHaveTextContent("37.4M");
    const first = script.holds[0];
    if (!first) throw new Error("Missing q1 hold");
    const firstTime = runToPlayback(script.timeline, first.t) + 500;
    await act(() => vi.advanceTimersByTimeAsync(firstTime));
    expect(claude).toHaveTextContent("question q1");
    expect(codex).toHaveTextContent("question pending");
    expect(live).toHaveTextContent("Codex has a question");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const held = codex.textContent;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(codex.textContent).toBe(held);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    let position = firstTime;
    for (const hold of script.holds.slice(1)) {
      const target = runToPlayback(script.timeline, hold.t) + 500;
      await act(() => vi.advanceTimersByTimeAsync(target - position));
      position = target;
      if (hold.label === "q1 Resolved") {
        expect(claude).toHaveTextContent("foreman answer fix-supervisor q1");
        expect(codex).toHaveTextContent("running");
      }
      if (hold.label === "q2 Asked") {
        expect(claude).toHaveTextContent("question q2");
        expect(codex).toHaveTextContent("question pending");
      }
      if (hold.label === "q2 Resolved") {
        expect(claude).toHaveTextContent("No answer from the orchestrator.");
        expect(claude).toHaveTextContent("15-minute question timeout expired");
      }
    }
    await act(() =>
      vi.advanceTimersByTimeAsync(script.playbackMs - position + 100),
    );
    expect(codex).toHaveTextContent("37.4M in / 174.8K out");
    expect(codex).toHaveTextContent("question q1");
    expect(codex).toHaveTextContent("question q2");
    expect(live).toHaveTextContent(
      "Turn complete. Claude reviews the hand-off.",
    );
    expect(claude).toHaveTextContent("before committing.");
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(claude).not.toHaveTextContent("question q1");
    expect(codex).not.toHaveTextContent("37.4M");
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  });
});
