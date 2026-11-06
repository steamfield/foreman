import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Git hooks (lefthook's pre-push runs this suite) export GIT_DIR and friends. A test that
// inherits them runs its temporary-repo git commands against the real repository.
describe("git isolation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("removes every repository-locating git variable before tests run", () => {
    const names = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(names).toContain("GIT_DIR");
    expect(names.filter((name) => process.env[name] !== undefined)).toEqual([]);
  });

  it("commits in a temporary repo land in that repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-isolation-"));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    expect(git("rev-parse", "--show-toplevel")).toContain("git-isolation-");
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
  });
});
