import { describe, expect, it } from "vitest";
import answerCapture from "../../fixtures/cli/answer.json";
import { loadRun } from "./runs";
import { buildSession, sceneAt, stepAt } from "./session";

const source = loadRun("site-commands");
const laneSources = {
  "site-console": loadRun("site-console"),
  "site-commands": source,
  "site-e2e": loadRun("site-e2e"),
};
const session = buildSession(source, laneSources);

describe("the simulated session", () => {
  it("keeps pre-question and post-answer activity on the correct side of the exchange", () => {
    const asked = source.questions.find((q) => q._tag === "Asked");
    const resolved = source.questions.find(
      (q) => q._tag === "Resolved" && q.id === asked?.id,
    );
    if (!asked || !resolved) throw new Error("Missing recorded exchange");
    const lane = session.delegates.find((d) => d.name === "site-commands");
    expect(lane?.activity.length).toBeGreaterThan(0);
    for (const sample of lane?.activity ?? []) {
      if (sample.event.t < asked.t) expect(sample.at).toBeLessThan(16_500);
      if (sample.event.t >= resolved.t)
        expect(sample.at).toBeGreaterThanOrEqual(22_000);
    }
  });

  it("shows only writes owned by each lane's displayed contract, with no overlapping ownership", () => {
    const owner = new Map<string, string>();
    for (const lane of session.delegates) {
      const paths = lane.activity.flatMap((a) =>
        a.event.kind === "files" ? a.event.paths : [],
      );
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(
          lane.scope
            .split(", ")
            .some((scope) =>
              scope.endsWith("/") ? path.startsWith(scope) : path === scope,
            ),
          `${lane.name} may not write ${path}`,
        ).toBe(true);
        expect(owner.get(path) ?? lane.name).toBe(lane.name);
        owner.set(path, lane.name);
      }
    }
  });

  it("pairs the first recorded question with its own answer, without changing either", () => {
    const asked = source.questions.find((q) => q._tag === "Asked");
    const answered = source.questions.find(
      (q) => q._tag === "Resolved" && q.id === asked?.id,
    );
    expect(asked?._tag === "Asked" && asked.question).toBe(
      session.question.text,
    );
    expect(answered?._tag === "Resolved" && answered.text).toBe(
      session.question.answer,
    );
    expect(session.question.id).toBe("q1");
    expect(session.steps[4]?.commands[1]).toBe(
      answerCapture.output.trim().split("next: ")[1],
    );
    expect(session.steps[4]?.commands[0]).toBe(answerCapture.command);
  });

  it("refuses a recording without a matching answer instead of inventing an exchange", () => {
    expect(() =>
      buildSession({ ...source, questions: [] }, laneSources),
    ).toThrow(/recorded question/);
    expect(() =>
      buildSession(
        {
          ...source,
          questions: source.questions.filter(
            (q) => q.id !== "q1" || q._tag === "Asked",
          ),
        },
        laneSources,
      ),
    ).toThrow(/matching answer/);
  });

  it("orders ten steps over 54 seconds and clamps lookups before and after playback", () => {
    expect(session.steps).toHaveLength(10);
    expect(session.duration).toBe(54_000);
    session.steps.forEach((step, i) => {
      expect(stepAt(session, step.at)).toBe(i);
      if (i > 0) expect(stepAt(session, step.at - 1)).toBe(i - 1);
    });
    expect(stepAt(session, -1)).toBe(0);
    expect(sceneAt(session, 100_000)).toEqual(
      sceneAt(session, session.duration),
    );
  });

  it("marks Claude idle only while its background wait is the whole job", () => {
    expect(sceneAt(session, 0).claudeActive).toBe(true);
    expect(sceneAt(session, 12_000).claudeActive).toBe(false);
    expect(sceneAt(session, session.stillAt).claudeActive).toBe(true);
    expect(sceneAt(session, session.duration).claudeActive).toBe(true);
  });

  it("starts isolated worktrees on the three specified models, staggered", () => {
    expect(session.delegates.map((d) => d.model)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
    ]);
    expect(sceneAt(session, 0).delegates.map((d) => d.state)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    expect(sceneAt(session, 5000).delegates.map((d) => d.state)).toEqual([
      "starting",
      "queued",
      "queued",
    ]);
    expect(sceneAt(session, 7000).delegates.map((d) => d.state)).toEqual([
      "running",
      "starting",
      "queued",
    ]);
    expect(
      sceneAt(session, 11_000).delegates.every((d) => d.state === "running"),
    ).toBe(true);
    session.delegates.forEach((d) => {
      expect(d.branch).toBe(`forman/${d.name}`);
      expect(session.steps[1]?.commands).toContain(
        `forman start ${d.name} --new-worktree --setup "bun install" --contract ${d.contract} --write --model ${d.model}`,
      );
    });
  });

  it("holds only site-commands and its counters while the other delegates continue", () => {
    const still = sceneAt(session, session.stillAt);
    expect(still.held).toBe(true);
    expect(still.step).toBe(3);
    expect(still.delegates.map((d) => d.state)).toEqual([
      "running",
      "waiting",
      "running",
    ]);
    expect(sceneAt(session, 16_500).delegates[1]).toEqual(
      sceneAt(session, 21_999).delegates[1],
    );
    expect(sceneAt(session, 21_999).delegates[0]?.commands).toBeGreaterThan(
      sceneAt(session, 16_500).delegates[0]?.commands ?? 0,
    );
    expect(sceneAt(session, 22_000).held).toBe(false);
    expect(sceneAt(session, 22_000).delegates[1]?.state).toBe("running");
  });

  it("steers turn 1, follows up with turn 2, then archives only after all runs finish", () => {
    expect(sceneAt(session, 27_500).delegates[2]).toMatchObject({
      state: "running",
      turn: 1,
    });
    expect(sceneAt(session, 32_500).delegates[0]).toMatchObject({
      state: "done",
      turn: 1,
    });
    expect(sceneAt(session, 38_000).delegates[0]).toMatchObject({
      state: "running",
      turn: 2,
    });
    expect(sceneAt(session, 41_500).delegates[0]).toMatchObject({
      state: "done",
      turn: 2,
    });
    expect(
      sceneAt(session, 46_000).delegates.every((d) => d.state === "done"),
    ).toBe(true);
    expect(
      sceneAt(session, session.duration).delegates.every(
        (d) => d.state === "archived",
      ),
    ).toBe(true);
  });

  it("takes every event sample from its stated recording and counts unique file paths", () => {
    session.delegates.forEach((d, i) => {
      expect(d.source).toBe(d.name);
      expect(d.activity.some((a) => a.event.kind === "command")).toBe(true);
      for (const { event } of d.activity)
        expect(loadRun(d.source).events).toContainEqual(event);
      const last = sceneAt(session, session.duration).delegates[i];
      expect(last?.commands).toBe(
        d.activity.filter((a) => a.event.kind === "command").length,
      );
      const paths = d.activity.flatMap((a) =>
        a.event.kind === "files" ? a.event.paths : [],
      );
      expect(last?.files).toBe(new Set(paths).size);
    });
  });

  it("routes packets through the daemon and reserves attention for questions", () => {
    const labels = new Set(session.packets.map((p) => p.label));
    expect([...labels]).toEqual(
      expect.arrayContaining([
        "start",
        "turn",
        "ask_orchestrator",
        "question q1",
        "answer",
        "steer",
        "done",
        "followup",
        "archive",
      ]),
    );
    for (const p of session.packets) {
      expect(p.from === "daemon" || p.to === "daemon").toBe(true);
      expect(p.attention).toBe(
        ["ask_orchestrator", "question q1"].includes(p.label),
      );
      const active = sceneAt(session, p.at + 750).packets.find(
        (a) => a.at === p.at && a.from === p.from && a.to === p.to,
      );
      expect(active?.progress).toBe(0.5);
    }
    expect(
      sceneAt(session, 14_000).packets.filter((p) => p.label === "events"),
    ).toHaveLength(3);
  });
});
