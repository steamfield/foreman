import { renderToString } from "ink";
import { createElement } from "react";
import { expect, it } from "vitest";
import { EVENT_BUFFER_LIMIT, initialState, reduce, view } from "../src/core/monitor/model";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { defaults, detailLive, live, messageEvents, now, run } from "./helpers/monitor";

// Run with: node node_modules/vitest/vitest.mjs bench tests/monitor-render.bench.ts --run
// Each sample renders 100 frames; the budget is 3 seconds per sample.
for (const kind of ["list", "detail"] as const) {
  it(`renders 100 ${kind} frames within 3 seconds`, async ({ bench }) => {
    const columns = kind === "list" ? 100 : 140;
    const initial = initialState({
      group: "/repo",
      defaults,
      version: "0.1.3",
      now,
      columns,
      rows: 40,
      ...(kind === "detail" ? { name: run("fix-hooks").name } : {}),
    });
    const current =
      kind === "list"
        ? reduce(initial, {
            type: "feed",
            value: live(Array.from({ length: 10 }, (_, i) => run(`run-${i}`, { state: "idle" }))),
          })
        : reduce(initial, {
            type: "detail-feed",
            name: run("fix-hooks").name,
            value: detailLive(undefined, messageEvents(EVENT_BUFFER_LIMIT)),
          });
    let last = "";
    const result = await bench(`100 ${kind} frames`, () => {
      for (let index = 0; index < 100; index++)
        last = renderToString(createElement(Screen, { model: view(current), colors: theme(0) }), {
          columns,
        });
    }).run({ iterations: 1, time: 0, warmup: false });
    expect(result.latency.mean).toBeLessThan(3000);
    expect(last).toContain(kind === "list" ? "run-9" : "event 1000");
  });
}
