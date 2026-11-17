import { renderToString } from "ink";
import { createElement } from "react";
import { expect, it } from "vitest";
import { reduce, view } from "../src/core/monitor/model";
import { Screen } from "../src/tui/screen";
import { theme } from "../src/tui/theme";
import { detail, focusFiles, inspectStart, monitorKey, run } from "./helpers/monitor";

it.each(["detail", "review"])(
  "renders unknown untracked counts in %s while retaining tracked binary labels",
  (screen) => {
    let state = inspectStart(detail(run("finished", { state: "idle" })));
    if (screen === "review") state = monitorKey(state, "r");
    state = reduce(state, {
      type: "changes-result",
      id: state.detail?.changes?.id ?? -1,
      error: null,
      files: [
        { path: "link-entry", status: "untracked", added: null, removed: null, outside: false },
        { path: "overflow.ts", status: "untracked", added: null, removed: null, outside: false },
        { path: "image.png", status: "added", added: null, removed: null, outside: false },
      ],
    });
    state = screen === "review" ? monitorKey(monitorKey(state, "tab"), "tab") : focusFiles(state);
    const model = view(state);
    if (screen === "detail") {
      expect(
        model.detail?.panes.find((pane) => pane.id === "files")?.lines.map((line) => line.text),
      ).toEqual(["? link-entry  ? ?", "? overflow.ts  ? ?", "A image.png  binary binary"]);
    } else {
      expect(
        model.review?.files.map(({ path, added, removed }) => ({ path, added, removed })),
      ).toEqual([
        { path: "link-entry", added: "?", removed: "?" },
        { path: "overflow.ts", added: "?", removed: "?" },
        { path: "image.png", added: "binary", removed: "binary" },
      ]);
    }
    const output = renderToString(createElement(Screen, { model, colors: theme(0, true) }), {
      columns: 140,
    });
    expect(output).toMatch(/link-entry[^\n]*\?[^\n]*\?/);
    expect(output).toMatch(/overflow\.ts[^\n]*\?[^\n]*\?/);
    expect(output).toMatch(/image\.png[^\n]*binary/);
  },
);
