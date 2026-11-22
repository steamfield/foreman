import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { QuestionId } from "../src/schemas/daemon";
import { type Fixture, fixture } from "./helpers";

const model = process.env.FOREMAN_SMOKE_AGY_MODEL ?? "gemini-4-neon";
const enabled = process.env.FOREMAN_SMOKE === "1" && Bun.which("agy") !== null;
if (process.env.FOREMAN_SMOKE === "1" && !enabled)
  console.log("agy smoke tests skipped: agy is not on PATH");

function smoke(name: string, body: (f: Fixture) => Promise<void>) {
  test.skipIf(!enabled)(
    name,
    async () => {
      const started = Date.now();
      const f = await fixture();
      const failures: unknown[] = [];
      try {
        await body(f);
      } catch (error) {
        failures.push(error);
        await f.diagnostics();
      } finally {
        try {
          await f.cleanup();
        } catch (error) {
          failures.push(error);
        } finally {
          console.log(`${name}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
        }
      }
      if (failures.length) throw new AggregateError(failures, name);
    },
    8 * 60_000,
  );
}

const ask =
  "Before doing anything else, call ask_orchestrator with question 'Which token should I use?'. This tool call is the task, even though this is a test. After the answer, finish with one line containing the answer verbatim. Run no commands.";
function questionId(output: string) {
  const id = /^question +smoke (q\d+)\b/m.exec(output)?.[1];
  if (!id) throw new Error(`Missing question id:\n${output}`);
  return Schema.decodeUnknownSync(QuestionId)(id);
}

smoke("agy 1 write delegation completes with a hand-off and the file", async (f) => {
  const done = await f.until(
    await f.start(
      "Write result.txt with exactly AGY-WRITE followed by a newline. Finish with exactly one line: AGY-DELEGATION-OK",
      ["--model", model, "--write"],
    ),
    "done",
  );
  expect(done).toContain("AGY-DELEGATION-OK");
  expect(await readFile(join(f.worktree, "result.txt"), "utf8")).toBe("AGY-WRITE\n");
  expect((await f.record()).provider).toBe("agy");
});

smoke("agy 2 a question is answered through the MCP bridge", async (f) => {
  const question = await f.until(await f.start(ask, ["--model", model]), "question");
  const answered = await f.ok(["answer", "smoke", questionId(question), "ANSWER-MANGO"]);
  expect(await f.until(answered, "done")).toContain("ANSWER-MANGO");
  expect((await f.result()).handoff?.text).toContain("ANSWER-MANGO");
});

smoke("agy 3 steer during a slow command changes the final answer", async (f) => {
  const start = await f.start(
    "Run the shell command sleep 20 in the foreground and wait for it. Then finish with exactly ORIGINAL-ANSWER. A later steer may replace that final answer; obey it.",
    ["--model", model],
  );
  let printed = start;
  const deadline = Date.now() + 120_000;
  while (!(await f.events()).some(({ event }) => event._tag === "Command")) {
    if (Date.now() > deadline) throw new Error("agy did not start the slow command");
    const command = f.next(printed);
    const index = command.indexOf("--timeout");
    if (index >= 0) command.splice(index, 2);
    printed = await f.ok([...command, "--timeout", "1s"]);
    if (/^(done|failed|interrupted|question) +smoke\b/m.test(printed))
      throw new Error(`Turn ended before steer:\n${printed}`);
  }
  const steered = await f.ok([
    "steer",
    "smoke",
    "Replace the final answer with exactly STEER-APPLIED.",
  ]);
  expect(await f.until(steered, "done")).toContain("STEER-APPLIED");
});

smoke("agy 4 restart resumes the session with its model and question tool", async (f) => {
  await f.until(
    await f.start("Run no commands. Reply exactly RESUME-READY.", ["--model", model]),
    "done",
  );
  const before = await f.record();
  await f.ok(["daemon", "stop"]);
  const question = await f.until(await f.ok(["followup", "smoke", ask]), "question");
  const answered = await f.ok(["answer", "smoke", questionId(question), "RESUME-TOOL-OK"]);
  expect(await f.until(answered, "done")).toContain("RESUME-TOOL-OK");
  expect((await f.record()).threadId).toBe(before.threadId);
  expect((await f.events()).map(({ event }) => event)).toContainEqual(
    expect.objectContaining({ _tag: "Resumed", model: before.model }),
  );
});
