// Stub: unit "evidence" replaces this file.
import type { Run } from "../../data/runs";

export function WorkOrder({ run }: { run: Run }) {
  return <div data-stub="work-order">{run.name}</div>;
}

export function QuestionTimeline({ run }: { run: Run }) {
  return <div data-stub="questions">{run.name}</div>;
}

export function ParallelRuns({ runs }: { runs: readonly Run[] }) {
  return <div data-stub="parallel">{runs.length}</div>;
}
