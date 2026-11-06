import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcess } from "effect/process";
import { commandResult } from "../src/core/process";

it.live("complete command output refuses overflow instead of returning partial data", () =>
  Effect.gen(function* () {
    const result = yield* commandResult(
      ChildProcess.make(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"]),
    ).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        detail: expect.stringContaining("output exceeded 1048576 bytes"),
      });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("tail capture bounds both pipes, keeps their ends and reports truncation", () =>
  Effect.gen(function* () {
    const result = yield* commandResult(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write('x'.repeat(2000000)+'OUT'); process.stderr.write('y'.repeat(2000000)+'ERR'); process.exitCode=23",
      ]),
      { output: "tail", maxOutputBytes: 4096 },
    );
    expect(result.code).toBe(23);
    expect(result.stdout.endsWith("OUT")).toBe(true);
    expect(result.stderr.endsWith("ERR")).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
    expect(result.truncated).toEqual({ stdout: true, stderr: true });
    expect(result.overflowNote).toContain("4096 bytes");
  }).pipe(Effect.provide(NodeServices.layer)),
);
