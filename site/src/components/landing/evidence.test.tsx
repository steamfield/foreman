import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParallelRuns, QuestionTimeline, WorkOrder } from "./evidence";
import { loadRun, releaseRuns } from "../../data/runs";
import { parallel } from "../../data/landing";

const run = loadRun("fix-supervisor");

describe("work order", () => {
  it("renders the contract excerpt and unmodified digest from real props", () => {
    const { container } = render(<WorkOrder run={run} />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      run.contract.split("\n")[0] ?? "",
    );
    expect(screen.getByText("May change", { exact: true })).toBeVisible();
    expect(screen.getAllByLabelText("Excerpt omitted")).toHaveLength(2);
    expect(screen.getByText(`forman status ${run.name}`)).toBeVisible();
    expect(container.querySelector("figure code")?.textContent).toBe(
      run.digest,
    );
    expect(screen.getByText(/Written for this page:/)).toHaveTextContent(
      /two test files/,
    );
  });

  it("server-renders a native disclosure containing the complete contract", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<WorkOrder run={run} />);
    const link = within(container).getByRole("link", { name: "Full contract" });
    const details = container.querySelector("details");
    expect(link.getAttribute("href")).toBe(`#${details?.id}`);
    expect(details?.querySelector("summary")?.textContent).toBe(
      "Read the full contract",
    );
    expect(details?.querySelector("pre")?.textContent).toBe(run.contract);
    expect(details?.open).toBe(false);
    expect(container.querySelector("figure code")?.textContent).toBe(
      run.digest,
    );
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
        /auto-answered by forman after the timeout · 15m00s later/,
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
    render(<ParallelRuns runs={releaseRuns} />);
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
    expect(screen.getByText("forman wait --all")).toBeVisible();
  });

  it("server-renders the chart and accessible figures in their final state", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ParallelRuns runs={releaseRuns} />,
    );
    expect(
      within(container).getByRole("table").querySelectorAll("tbody tr"),
    ).toHaveLength(4);
    expect(container.textContent).toContain("70m30s");
    expect(container.textContent).toContain("Codex asked a question");
    expect(container.querySelector("script")).toBeNull();
  });
});
