import type { ListColumns } from "./model";

const MIN_WIDTH: Readonly<Record<keyof ListColumns, number>> = {
  task: 80,
  model: 90,
  progress: 100,
  pace: 120,
  budgetLabel: 140,
};

/** Chooses optional columns in their fixed order of removal. */
export function listColumns(width: number): ListColumns {
  return {
    task: width >= MIN_WIDTH.task,
    model: width >= MIN_WIDTH.model,
    progress: width >= MIN_WIDTH.progress,
    pace: width >= MIN_WIDTH.pace,
    budgetLabel: width >= MIN_WIDTH.budgetLabel,
  };
}
