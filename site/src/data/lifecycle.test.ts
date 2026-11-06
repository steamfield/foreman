import { describe, expect, it, test } from "vitest";
import start from "../../fixtures/cli/start-wait.json";
import supervisor from "../../fixtures/runs/fix-supervisor.json";
import {
  lifecycleModel,
  tourAt,
  tourLength,
  tourRoutes,
  tourStopMs,
} from "./lifecycle";

test("the lifecycle includes the question loop and all four wait endings", () => {
  const model = lifecycleModel();
  expect(model.nodes.map((node) => node.id)).toEqual([
    "contract",
    "start",
    "running",
    "question",
    "done",
    "failed",
    "interrupted",
    "lost",
    "review",
    "archive",
  ]);
  expect(
    model.edges
      .filter((edge) => edge.from === "running")
      .map((edge) => edge.to),
  ).toEqual(["question", "done", "failed", "interrupted", "lost"]);
  expect(model.edges).toContainEqual({
    from: "question",
    to: "running",
    label: "answer / timeout",
  });
  for (const edge of model.edges) {
    expect(model.nodes.some((node) => node.id === edge.from)).toBe(true);
    expect(model.nodes.some((node) => node.id === edge.to)).toBe(true);
  }
});

test("start and done are disjoint verbatim excerpts of the CLI capture", () => {
  const model = lifecycleModel();
  const started = model.nodes.find((node) => node.id === "start")?.excerpt
    ?.text;
  const done = model.nodes.find((node) => node.id === "done")?.excerpt?.text;
  expect(started).toBe(start.output.split("\n").slice(0, 4).join("\n"));
  expect(done).toBe(start.output.split("\n").slice(4, 14).join("\n"));
  expect(start.output).toContain(started);
  expect(start.output).toContain(done);
});

test("question uses q1 verbatim and unrecorded states never fabricate output", () => {
  const nodes = lifecycleModel().nodes;
  expect(nodes.find((node) => node.id === "question")?.excerpt?.text).toBe(
    supervisor.questions.find(
      (question) => question._tag === "Asked" && question.id === "q1",
    )?.question,
  );
  for (const id of [
    "contract",
    "running",
    "failed",
    "interrupted",
    "lost",
    "review",
  ]) {
    expect(nodes.find((node) => node.id === id)?.excerpt).toBeUndefined();
  }
});

const archives = import.meta.glob<{ command: string; output: string }>(
  "../../fixtures/cli/archive.json",
  { eager: true, import: "default" },
);

test("archive still explains safe cleanup when the optional capture is absent", () => {
  const archive = lifecycleModel({}).nodes.find(
    (node) => node.id === "archive",
  );
  expect(archive?.excerpt).toBeUndefined();
  expect(archive?.claude).toContain("--keep-worktree");
  expect(archive?.reports).toContain("uncommitted or untracked files");
});

test.each(Object.values(archives))(
  "archive preserves a supplied recording verbatim",
  (recording) => {
    expect(
      lifecycleModel({ archive: recording }).nodes.find(
        (node) => node.id === "archive",
      )?.excerpt?.text,
    ).toBe(recording.output);
    expect(
      lifecycleModel().nodes.find((node) => node.id === "archive")?.excerpt
        ?.text,
    ).toBe(recording.output);
  },
);

describe("lifecycle tour", () => {
  const model = lifecycleModel();

  it("walks real edges, asking once and ending each loop a different way", () => {
    const routes = tourRoutes(model);
    expect(routes.map((route) => route.at(-3))).toEqual([
      "done",
      "failed",
      "interrupted",
      "lost",
    ]);
    expect(routes[0]).toContain("question");
    expect(routes.slice(1).some((route) => route.includes("question"))).toBe(
      false,
    );
    expect(tourLength(model)).toBe(routes.flat().length * tourStopMs);
  });

  it("crosses an edge before resting on the next stage", () => {
    expect(tourAt(model, 0)).toEqual({ node: "contract", edge: undefined });
    expect(tourAt(model, tourStopMs + 100)).toEqual({
      node: "contract",
      edge: { from: "contract", to: "start" },
    });
    expect(tourAt(model, tourStopMs * 2 - 1)).toEqual({
      node: "start",
      edge: undefined,
    });
    expect(tourAt(model, tourStopMs * 3 + 600).node).toBe("question");
    expect(tourAt(model, tourLength(model))).toEqual({
      node: "archive",
      edge: undefined,
    });
  });

  it("refuses a route over an edge the diagram does not draw", () => {
    expect(() =>
      tourRoutes({
        ...model,
        edges: model.edges.filter((e) => e.to !== "question"),
      }),
    ).toThrow("running→question");
  });
});
