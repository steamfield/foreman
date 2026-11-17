import { describe, expect, it } from "vitest";
import { reduce, view } from "../src/core/monitor/model";
import { focusFiles, inspectStart, monitorKey } from "./helpers/monitor";

function diff(text: string) {
  let state = inspectStart();
  state = reduce(state, {
    type: "changes-result",
    id: 1,
    files: [{ path: "a", status: "modified", added: 1, removed: 1, outside: false }],
    error: null,
  });
  state = monitorKey(focusFiles(state), "d");
  return view(
    reduce(state, { type: "diff-result", id: 2, text: { text, truncated: false }, error: null }),
  ).diff;
}

describe("unified diff model", () => {
  it("treats header-like lines inside hunks as file content", () => {
    expect(diff("--- a/a\n+++ b/a\n@@ -1 +1 @@\n--- old\n+++ new")?.lines.slice(-2)).toEqual([
      { text: "--- old", kind: "remove", oldLine: 1, newLine: null },
      { text: "+++ new", kind: "add", oldLine: null, newLine: 1 },
    ]);
  });
  it("tracks old and new numbers across hunks and context", () => {
    expect(
      diff("--- a/a\n+++ b/a\n@@ -10,2 +20,2 @@\n same\n-old\n+new\n@@ -50 +60 @@\n-a\n+b")?.lines,
    ).toEqual([
      { text: "--- a/a", kind: "meta", oldLine: null, newLine: null },
      { text: "+++ b/a", kind: "meta", oldLine: null, newLine: null },
      { text: "@@ -10,2 +20,2 @@", kind: "hunk", oldLine: null, newLine: null },
      { text: " same", kind: "context", oldLine: 10, newLine: 20 },
      { text: "-old", kind: "remove", oldLine: 11, newLine: null },
      { text: "+new", kind: "add", oldLine: null, newLine: 21 },
      { text: "@@ -50 +60 @@", kind: "hunk", oldLine: null, newLine: null },
      { text: "-a", kind: "remove", oldLine: 50, newLine: null },
      { text: "+b", kind: "add", oldLine: null, newLine: 60 },
    ]);
  });
  it("keeps no-newline markers as metadata without consuming line numbers", () => {
    expect(
      diff(
        "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n",
      )?.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    ).toEqual([
      ["hunk", null, null],
      ["remove", 1, null],
      ["meta", null, null],
      ["add", null, 1],
      ["meta", null, null],
    ]);
  });
  it("preserves rename headers as metadata", () => {
    expect(
      diff(
        "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new",
      )?.lines.map((l) => l.kind),
    ).toEqual(["meta", "meta", "meta", "meta"]);
  });
  it("preserves binary notices with no hunk position", () => {
    const model = diff("Binary files a/a and b/a differ");
    expect(model?.lines).toEqual([
      { text: "Binary files a/a and b/a differ", kind: "meta", oldLine: null, newLine: null },
    ]);
    expect(model?.position).toBe("hunk 0 of 0");
  });
  it("numbers untracked new file additions from one", () => {
    expect(
      diff("--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+first\n+second")?.lines.slice(-2),
    ).toEqual([
      { text: "+first", kind: "add", oldLine: null, newLine: 1 },
      { text: "+second", kind: "add", oldLine: null, newLine: 2 },
    ]);
  });
});
