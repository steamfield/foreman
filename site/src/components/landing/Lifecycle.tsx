// Stub: unit "lifecycle" replaces this file.
import type { LifecycleModel } from "../../data/lifecycle";

export function Lifecycle({ model }: { model: LifecycleModel }) {
  return <div data-stub="lifecycle">{model.states.length}</div>;
}
