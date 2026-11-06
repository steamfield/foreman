import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DateTime, Schema } from "effect";
import { QuestionLine } from "../src/schemas/daemon";
import { DoctorResult } from "../src/schemas/doctor";
import { type Fixture, fixture } from "./helpers";

const enabled = process.env.FORMAN_SMOKE === "1";
const short = process.env.FORMAN_SMOKE_SHORT === "1";
const long = process.env.FORMAN_SMOKE_LONG === "1";
if (!enabled) console.log("Smoke tests skipped: enable with FORMAN_SMOKE=1 bun run smoke");
if (!long && !short)
  console.log(
    "Long question hold skipped: enable with FORMAN_SMOKE=1 FORMAN_SMOKE_LONG=1 bun run smoke",
  );

function smoke(name: string, body: (f: Fixture) => Promise<void>, hold = false) {
  test.skipIf(!enabled || (hold && !long && !short))(
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
    hold ? 22 * 60_000 : 8 * 60_000,
  );
}

const ask =
  "Before doing anything else, call ask_orchestrator with question 'Which token should I use?'. This tool call is the task, even though this is a test. After the answer, finish with one line containing the answer verbatim. Run no commands.";
function questionId(output: string) {
  const id = /^question +smoke (q\d+)\b/m.exec(output)?.[1];
  if (!id) throw new Error(`Missing question id:\n${output}`);
  return id;
}

smoke("1 delegation wakes with hand-off, digest, result and archive", async (f) => {
  const done = await f.start(
    "Write result.txt with exactly SMOKE-WRITE followed by a newline. Finish with exactly one line: DELEGATION-OK",
    ["--new-worktree", "--setup", "true", "--write", "--wait"],
  );
  expect(done).toContain("done        smoke turn 1");
  expect(done).toContain("DELEGATION-OK");
  expect(done).toContain("result.txt");
  expect(done).toContain(`branch: forman/smoke`);
  expect(await readFile(join(f.repo, ".claude/worktrees/smoke/result.txt"), "utf8")).toBe(
    "SMOKE-WRITE\n",
  );
  const result = await f.result();
  expect(result.digest.filesWritten).toContain("result.txt");
  expect(result.handoff?.text.trim()).toBe("DELEGATION-OK");
  expect(done).toContain(result.handoff?.text ?? "missing hand-off");
  expect(result.latestTurnWithoutHandoff).toBe(false);
  const archived = await f.json(["archive", "smoke", "--keep-worktree"]);
  expect(archived._tag).toBe("Archived");
  if (archived._tag !== "Archived") throw new Error("Missing archive");
  expect(archived.archivePath.startsWith(join(f.data, "runs/.archive/"))).toBe(true);
  expect(await readFile(join(archived.archivePath, "turns/1.md"), "utf8")).toContain(
    "DELEGATION-OK",
  );
  expect(await f.json(["status"])).toMatchObject({ _tag: "Digests", digests: [] });
});

smoke("2 one question completes in two delegation calls with --wait", async (f) => {
  const question = await f.start(ask, ["--wait"]);
  expect((await f.events()).some(({ event }) => event._tag === "Command")).toBe(false);
  const done = await f.ok(["answer", "smoke", questionId(question), "ANSWER-PINEAPPLE", "--wait"]);
  expect(done).toContain("done        smoke turn 1");
  expect(done).toContain("ANSWER-PINEAPPLE");
  expect((await f.result()).handoff?.text).toContain("ANSWER-PINEAPPLE");
});

smoke("3 steer during slow commands changes the final answer", async (f) => {
  const start = await f.start(
    "Run four separate simple commands, each exactly sleep 5, sequentially. Do not combine them. Then finish with exactly ORIGINAL-ANSWER. A later steer may replace that final answer; obey it.",
  );
  let printed = start;
  const deadline = Date.now() + 120_000;
  while (
    !(await f.events()).some(
      ({ event }) => event._tag === "Command" && event.command.includes("sleep 5"),
    )
  ) {
    if (Date.now() > deadline) throw new Error("Codex did not start the slow commands");
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
    "Replace the final answer with exactly STEER-APPLIED. Continue the remaining slow commands.",
  ]);
  expect(await f.until(steered, "done")).toContain("STEER-APPLIED");
  const result = await f.result();
  expect(result.handoff?.text.trim()).toBe("STEER-APPLIED");
  expect(result.digest.commands).toMatchObject({ total: 4, failed: 0 });
  const late = await f.run(["steer", "smoke", "Reply LATE-STEER", "--json"]);
  expect(late.status).toBe(8);
  expect(late.stdout).toBe("");
  expect(late.stderr).toContain("RunConflict");
});

smoke("4 interrupt cancels a question, refuses its answer and permits followup", async (f) => {
  const question = await f.until(await f.start(ask), "question");
  await f.ok(["interrupt", "smoke"]);
  await f.until(question, "interrupted");
  const refused = await f.run(["answer", "smoke", questionId(question), "TOO-LATE", "--json"]);
  expect(refused.status).toBe(8);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("RunConflict");
  const followup = await f.ok([
    "followup",
    "smoke",
    "Run no commands and ask no questions. Reply exactly FOLLOWUP-OK.",
    "--effort",
    "low",
  ]);
  expect(await f.until(followup, "done")).toContain("FOLLOWUP-OK");
});

smoke("5 restart resumes the read-only sandbox and preserves ask_orchestrator", async (f) => {
  await f.until(await f.start("Run no commands. Reply exactly RESUME-READY."), "done");
  const before = await f.record();
  await f.ok(["daemon", "stop"]);
  const followup = await f.ok(["followup", "smoke", ask, "--effort", "low"]);
  const question = await f.until(followup, "question");
  const answered = await f.ok(["answer", "smoke", questionId(question), "RESUME-TOOL-OK"]);
  expect(await f.until(answered, "done")).toContain("RESUME-TOOL-OK");
  expect((await f.record()).threadId).toBe(before.threadId);
  const resume = (await f.wire("in")).find((rpc) => rpc.method === "thread/resume");
  expect(resume).toBeDefined();
  const response = (await f.wire("out")).findLast(
    (rpc) => rpc.id === resume?.id && rpc.result !== undefined,
  );
  expect(response?.result).toMatchObject({ sandbox: { type: "readOnly" }, model: before.model });
  expect((await f.events()).map(({ event }) => event)).toContainEqual({
    _tag: "Resumed",
    sandbox: "readOnly",
    model: before.model,
  });
  console.log("Resume observation: ask_orchestrator available; server sandbox readOnly.");
});

smoke("10 restart resumes write access and writes a file", async (f) => {
  await f.until(
    await f.start("Run no commands. Reply exactly WRITE-RESUME-READY.", ["--write"]),
    "done",
  );
  const before = await f.record();
  await f.ok(["daemon", "stop"]);
  const followup = await f.ok([
    "followup",
    "smoke",
    "Write result.txt with exactly WRITE-RESUMED followed by a newline. Finish with WRITE-RESUMED.",
    "--effort",
    "low",
  ]);
  expect(await f.until(followup, "done")).toContain("WRITE-RESUMED");
  expect(await readFile(join(f.worktree, "result.txt"), "utf8")).toBe("WRITE-RESUMED\n");
  expect((await f.record()).threadId).toBe(before.threadId);
  const resume = (await f.wire("in")).find((rpc) => rpc.method === "thread/resume");
  expect(resume?.params).toMatchObject({ sandbox: "danger-full-access" });
  const response = (await f.wire("out")).findLast(
    (rpc) => rpc.id === resume?.id && rpc.result !== undefined,
  );
  expect(response?.result).toMatchObject({
    sandbox: { type: "dangerFullAccess" },
    model: before.model,
  });
  expect((await f.events()).map(({ event }) => event)).toContainEqual({
    _tag: "Resumed",
    sandbox: "dangerFullAccess",
    model: before.model,
  });
  expect((await f.result()).digest.warnings).toEqual([]);
});

smoke("6 budget expiry collects a read-only hand-off and restores write on followup", async (f) => {
  const start = await f.start(
    "Run the simple command sleep 120 and wait for it to exit. Only after that write result.txt with TOO-LATE. If interrupted by the budget, report BUDGET-HANDOFF in your hand-off.",
    ["--write", "--budget", "45s"],
  );
  const interrupted = await f.until(start, "interrupted");
  expect(interrupted).toContain("BUDGET-HANDOFF");
  const result = await f.result();
  expect(result.digest.state).toBe("interrupted");
  expect(result.digest.turnKind).toBe("handoff");
  expect(result.handoff?.turn).toBe(2);
  expect(
    (await f.events()).some(({ event }) => event._tag === "Interrupted" && event.by === "budget"),
  ).toBe(true);
  const starts = (await f.wire("in")).filter((rpc) => rpc.method === "turn/start");
  expect(starts.at(-1)?.params).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  const followup = await f.ok([
    "followup",
    "smoke",
    "Write result.txt with exactly WRITE-RESTORED followed by a newline. Finish with WRITE-RESTORED.",
    "--effort",
    "low",
  ]);
  expect(await f.until(followup, "done")).toContain("WRITE-RESTORED");
  expect(await readFile(join(f.worktree, "result.txt"), "utf8")).toBe("WRITE-RESTORED\n");
  expect(
    (await f.wire("in")).filter((rpc) => rpc.method === "turn/start").at(-1)?.params,
  ).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
});

smoke("7 codex exec self-review runs inside a forman thread", async (f) => {
  const command =
    'codex exec --ephemeral --sandbox read-only -m gpt-6.1-sol -c model_reasoning_effort=low "Reply with exactly: REVIEW-OK"';
  const done = await f.until(
    await f.start(
      `Run this exact simple command once: ${command}\nReport its exit status and output. Do not substitute your own answer for executing it.`,
      ["--write", "--model", "gpt-6.1-sol"],
    ),
    "done",
  );
  expect(done).toContain("REVIEW-OK");
  const commands = (await f.events())
    .map(({ event }) => event)
    .filter((event) => event._tag === "Command" && event.command.includes("codex exec"));
  expect(commands).toContainEqual(
    expect.objectContaining({ exitCode: 0, outputTail: expect.stringContaining("REVIEW-OK") }),
  );
});

smoke("8 unapproved repo hooks refuse start before any turn and doctor explains", async (f) => {
  await mkdir(join(f.repo, ".codex"));
  await writeFile(
    join(f.repo, ".codex/hooks.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
    }),
  );
  const contract = join(f.root, "contract.md");
  await writeFile(contract, "Run no commands. Reply HOOKS-MUST-REFUSE.");
  const refused = await f.run([
    "start",
    "smoke",
    "--worktree",
    f.worktree,
    "--contract",
    contract,
    "--effort",
    "low",
    "--json",
  ]);
  expect(refused.status).toBe(10);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("RepoHooksUntrusted");
  const doctor = await f.ok(["doctor"]);
  expect(doctor).toMatch(/start will refuse/);
  const structured = Schema.decodeUnknownSync(DoctorResult)(
    JSON.parse(await f.ok(["doctor", "--json"])),
  );
  expect(structured.repoHooks).toMatchObject({ state: "known", acceptsStart: false });
  expect((await f.wire("in")).some((rpc) => rpc.method === "turn/start")).toBe(false);
});

smoke(
  "9 unanswered question auto-answers after its timeout and survives the hold",
  async (f) => {
    const timeout = short ? "1m" : "15m";
    const holdMs = (short ? 2 : 16) * 60_000;
    const question = await f.until(
      await f.start(
        "Before doing anything else call ask_orchestrator with question 'Choose the label or let me choose after timeout'. Wait for its answer. If told to proceed with best judgment, include the standalone completion marker AUTO-ANSWER-USED and the received answer in your final hand-off. Run no commands.",
        ["--question-timeout", timeout, "--budget", "20m"],
      ),
      "question",
    );
    const heldAt = Date.now();
    const done = await f.until(question, "done", short ? "2m" : "16m");
    expect(done).toContain("AUTO-ANSWER-USED");
    expect((await f.result()).handoff?.text).toContain("No answer from the orchestrator");
    expect(
      (await f.events()).some(
        ({ event }) => event._tag === "QuestionResolved" && event.resolution === "auto-answered",
      ),
    ).toBe(true);
    const history = (await readFile(join(f.data, "runs/smoke/questions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(QuestionLine)(JSON.parse(line)));
    const asked = history.find((line) => line._tag === "Asked");
    const answered = history.find((line) => line._tag === "Resolved");
    if (!asked || !answered) throw new Error("Missing timed question history");
    expect(
      DateTime.toEpochMillis(answered.at) - DateTime.toEpochMillis(asked.at),
    ).toBeGreaterThanOrEqual((short ? 60_000 : 900_000) - 1000);
    let printed = done;
    while (Date.now() - heldAt < holdMs) {
      const command = f.next(printed);
      const index = command.indexOf("--timeout");
      if (index >= 0) command.splice(index, 2);
      printed = await f.ok([
        ...command,
        "--timeout",
        `${Math.ceil(holdMs - (Date.now() - heldAt))}ms`,
      ]);
    }
    expect((await f.result()).digest.state).toBe("idle");
  },
  true,
);
