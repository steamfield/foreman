import { describe, expect, it } from "vitest";
import { loadRun } from "./runs";
import {
  buildConsoleScript,
  playbackToRun,
  runToPlayback,
  snapshotAt,
} from "./supervision";

const run = loadRun("fix-supervisor");
const script = buildConsoleScript(run);

describe("the recorded supervision script", () => {
  it("maps the whole run monotonically to one minute, including the final idle event", () => {
    expect(script.playbackMs).toBeCloseTo(60_000, 6);
    expect(playbackToRun(script.timeline, -1)).toBe(0);
    expect(playbackToRun(script.timeline, script.playbackMs + 1)).toBe(
      script.durationMs,
    );
    expect(snapshotAt(script, script.durationMs).state).toBe("done");
    let previous = 0;
    for (let playback = 0; playback <= 60_000; playback += 50) {
      const time = playbackToRun(script.timeline, playback);
      expect(time).toBeGreaterThanOrEqual(previous);
      previous = time;
    }
    for (const event of run.events) {
      expect(
        playbackToRun(script.timeline, runToPlayback(script.timeline, event.t)),
      ).toBeCloseTo(event.t, 5);
    }
  });

  it("holds both questions, both resolutions and completion for 2.5 seconds", () => {
    expect(script.holds.map((hold) => hold.label)).toEqual([
      "q1 Asked",
      "q1 Resolved",
      "q2 Asked",
      "q2 Resolved",
      "done",
    ]);
    script.holds.forEach((hold, i) => {
      const start = runToPlayback(script.timeline, hold.t);
      expect(playbackToRun(script.timeline, start + 1)).toBe(hold.t);
      expect(playbackToRun(script.timeline, start + 2499)).toBe(hold.t);
      expect(snapshotAt(script, hold.t).state).toBe(
        ["waiting", "running", "waiting", "running", "done"][i],
      );
    });
  });

  it("compresses the long unanswered wait more than active work", () => {
    const asked = run.questions.find(
      (q) => q.id === "q2" && q._tag === "Asked",
    );
    const resolved = run.questions.find(
      (q) => q.id === "q2" && q._tag === "Resolved",
    );
    if (!asked || !resolved) throw new Error("Missing q2 fixture");
    const waitPlayback =
      runToPlayback(script.timeline, resolved.t) -
      runToPlayback(script.timeline, asked.t) -
      2500;
    expect(waitPlayback / (resolved.t - asked.t)).toBeLessThan(
      script.playbackMs / script.durationMs,
    );
  });

  it("samples only commands, deterministically, retaining every other recorded event", () => {
    expect(buildConsoleScript(run)).toEqual(script);
    expect(script.events.filter((e) => e.kind !== "command")).toEqual(
      run.events.filter((e) => e.kind !== "command"),
    );
    expect(
      script.events.filter((e) => e.kind === "command").length,
    ).toBeLessThan(60);
    for (const event of script.events) {
      const recorded = run.events.find((e) => e.seq === event.seq);
      expect(recorded).toMatchObject(event);
    }
  });

  it("counts all commands and distinct files, including commands omitted from the feed", () => {
    expect(snapshotAt(script, 0)).toMatchObject({
      state: "starting",
      commands: 0,
      failed: 0,
      files: 0,
    });
    for (const hold of script.holds) {
      const events = run.events.filter((e) => e.t <= hold.t);
      expect(snapshotAt(script, hold.t)).toMatchObject({
        commands: events.filter((e) => e.kind === "command").length,
        failed: events.filter(
          (e) =>
            e.kind === "command" && e.exitCode !== null && e.exitCode !== 0,
        ).length,
        files: new Set(
          events.flatMap((e) => (e.kind === "files" ? e.paths : [])),
        ).size,
      });
    }
    expect(snapshotAt(script, script.durationMs)).toMatchObject({
      commands: 299,
      failed: 34,
      files: 18,
    });
    expect(script.tokens).toEqual(run.tokens);
  });

  it("preserves the questions, full answers and digest lines without inventing a q2 answer command", () => {
    for (const question of run.questions) {
      const text =
        question._tag === "Asked" ? question.question : question.text;
      expect(
        script.steps.some(
          (step) => step.t === question.t && step.text.includes(text),
        ),
      ).toBe(true);
    }
    const identity =
      script.steps.find((step) => step.id === "identity")?.text ?? "";
    for (const line of identity.split("\n"))
      expect(run.digest.split("\n")).toContain(line);
    const done = script.steps.find((step) => step.id === "done")?.text ?? "";
    expect(done).toBe(
      run.digest.split("\n").find((line) => line.startsWith("commands:")),
    );
    expect(script.steps.filter((step) => step.kind === "tool")).toHaveLength(2);
    expect(script.steps.map((step) => step.t)).toEqual(
      script.steps.map((step) => step.t).sort((a, b) => a - b),
    );
  });
});
