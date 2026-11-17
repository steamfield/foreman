import type { ActView } from "../core/monitor/act";
import type { DiffView, ReviewView, ViewModel } from "../core/monitor/model";

/** Supplies structured detail files until the model exposes them on ViewModel. */
export type InspectViewModel = ViewModel & {
  readonly files?: ReviewView["files"];
  readonly filesFocused?: boolean;
  readonly review: (ReviewView & { readonly diff?: DiffView | null }) | null;
};

/** Supplies the answer's preceding feed context when the model has loaded it. */
export type ContextAnswer = NonNullable<ActView["answer"]> & {
  readonly context?: readonly string[];
};

/** Carries controlled feed search text to the monitor model. */
export type InspectMessage = { readonly type: "feed-search-text"; readonly text: string };
