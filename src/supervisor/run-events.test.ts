import { describe, expect, it } from "vitest";
import { toRunEvents } from "./run-events";

describe("toRunEvents", () => {
  it("journals a permission decision", () => {
    expect(
      toRunEvents(
        {
          _tag: "Permission",
          turn: "t1",
          kind: "edit",
          title: "File result.txt",
          decision: "rejected",
        },
        1,
        "start",
      ),
    ).toEqual([
      { _tag: "Permission", kind: "edit", title: "File result.txt", decision: "rejected" },
    ]);
  });

  it("journals nothing for activity", () => {
    expect(toRunEvents({ _tag: "Activity", turn: "t1" }, 1, "start")).toEqual([]);
  });
});
