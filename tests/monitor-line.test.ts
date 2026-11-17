import { describe, expect, it } from "vitest";
import type { MonitorFeed } from "../src/core/monitor/feed";
import { lineSegments } from "../src/core/monitor/line";
import { at, live, now, overview, question, run } from "./helpers/monitor";

const text = (feed: MonitorFeed) =>
  lineSegments(feed, now)
    .map((segment) => segment.text)
    .join("");
const pending = question.id ? [question.id] : [];
const saved = (count: number, reason: "no-daemon" | "outdated" = "no-daemon"): MonitorFeed => ({
  _tag: "Saved",
  reason,
  overview: { _tag: "Overview", daemon: null, runs: Array.from({ length: count }, () => run()) },
  receivedAt: now,
  nextProbeAt: now + 10000,
});

describe("monitor line segments", () => {
  it("leads with the oldest pending question across runs and counts two more", () => {
    const newer = pending.map((q) => ({ ...q, askedAt: at(-60000) }));
    const feed = live([
      run("newer", { state: "waiting", questions: [...newer, ...newer] }),
      run("fix-hooks", { state: "waiting", questions: pending }),
      run("worker"),
      run("done", { state: "idle" }),
      run("failed", { state: "failed" }),
    ]);
    expect(text(feed)).toBe("›››  ■ fix-hooks q2 3m +2 more  ·  ⣾ 3 working  ✓ 1 done  × 1 failed");
    expect(lineSegments(feed, now)).toContainEqual({
      text: "■ fix-hooks q2 3m +2 more",
      tone: "signal",
    });
  });

  it("groups active states as working and idle as done when no questions need attention", () => {
    expect(
      text(
        live([
          run("starting", { state: "starting" }),
          run(),
          run("waiting", { state: "waiting" }),
          run("unknown", { state: "unknown" }),
          run("done1", { state: "idle" }),
          run("done2", { state: "idle" }),
        ]),
      ),
    ).toBe("›››  ⣾ 4 working  ✓ 2 done  ·  nothing needs you");
  });

  it("keeps zero working, omits other zeros and counts failed separately from lost and interrupted", () => {
    expect(text(live([]))).toBe("›››  ⣾ 0 working  ·  nothing needs you");
    const feed = live([
      run("failed", { state: "failed" }),
      run("lost", { state: "lost" }),
      run("interrupted", { state: "interrupted" }),
    ]);
    expect(text(feed)).toBe("›››  ⣾ 0 working  × 1 failed  ■ 1 interrupted  ·  nothing needs you");
    expect(lineSegments(feed, now)).toContainEqual({
      text: "■ 1 interrupted",
      tone: "interrupted",
    });
  });

  it("prints saved runs with no daemon", () => {
    expect(text(saved(2))).toBe("›››  no daemon · 2 runs saved");
  });

  it("prints saved state without runs", () => {
    expect(text(saved(0))).toBe("›››  no daemon · 0 runs saved");
  });

  it("names an outdated daemon", () => {
    expect(text(saved(1, "outdated"))).toBe("›››  daemon outdated · 1 runs saved");
  });

  it("retains the live line and appends reconnecting", () => {
    const runs = [run("fix-hooks", { state: "waiting", questions: pending })];
    expect(
      text({ _tag: "Reconnecting", last: overview(runs), retryAt: now + 1000, reason: "offline" }),
    ).toBe(`${text(live(runs))} · reconnecting`);
  });

  it("shows reconnecting when no live overview has arrived", () => {
    expect(text({ _tag: "Reconnecting", last: null, retryAt: now + 1000, reason: "offline" })).toBe(
      "›››  reconnecting",
    );
  });
});
