import { describe, expect, it } from "vitest";
import { permissionTitle } from "../../src/providers/agy/permission-requests";

const call = (title: string, path?: string) => ({
  toolCallId: "call_1",
  kind: "edit",
  title,
  ...(path === undefined ? {} : { locations: [{ path }] }),
});

describe("permissionTitle", () => {
  it("shows a file inside the worktree relative to it, not to agy's launch directory", () => {
    expect(
      permissionTitle(call("File ../../../../repo/w/src/a.ts", "/repo/w/src/a.ts"), "/repo/w"),
    ).toBe("File src/a.ts");
  });

  it("shows a file outside the worktree by its absolute path", () => {
    expect(permissionTitle(call("File ../../../../etc/hosts", "/etc/hosts"), "/repo/w")).toBe(
      "File /etc/hosts",
    );
  });

  it("keeps agy's title for tools that aren't file titles or have no location", () => {
    expect(permissionTitle(call("git status --short", "/repo/w"), "/repo/w")).toBe(
      "git status --short",
    );
    expect(permissionTitle(call("File result.txt"), "/repo/w")).toBe("File result.txt");
    expect(permissionTitle(call("File x", "/repo/w/x"), null)).toBe("File x");
  });
});
