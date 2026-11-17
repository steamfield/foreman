import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Schema } from "effect";
import { ToolCallResponse } from "../src/schemas/codex";
import { DaemonResult, QuestionLine } from "../src/schemas/daemon";
import { Scenario } from "../tests/fixtures/fake-app-server/scenario";
import { askOrchestrator } from "../tests/fixtures/fake-app-server/scenarios";

const binary = resolve("dist/foreman");

function monitor(repo: string, env: Record<string, string>) {
  let output = "";
  const decoder = new TextDecoder();
  const listeners = new Set<() => void>();
  let closeTerminal = () => {};
  const closed = new Promise<void>((resolve) => {
    closeTerminal = resolve;
  });
  const child = Bun.spawn([binary, "monitor"], {
    cwd: repo,
    env,
    timeout: 15_000,
    terminal: {
      cols: 100,
      rows: 30,
      data(_terminal, bytes) {
        output += decoder.decode(bytes, { stream: true });
        for (const notify of listeners) notify();
      },
      exit: () => closeTerminal(),
    },
  });
  const terminal = child.terminal;
  if (!terminal) throw new Error("Expected a Bun PTY");
  const waitFor = async (text: string, after = 0) => {
    let notify = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          notify = () => {
            const frame = output.slice(after);
            if (frame.endsWith("\x1b[?2026l") && stripVTControlCharacters(frame).includes(text))
              resolve();
          };
          listeners.add(notify);
          notify();
          timer = setTimeout(
            () => reject(new Error(`No frame containing ${JSON.stringify(text)}:\n${output}`)),
            5_000,
          );
        }),
        child.exited.then((status) => {
          throw new Error(`Monitor exited ${status} waiting for ${text}:\n${output}`);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      listeners.delete(notify);
    }
  };
  const key = (text: string) => {
    const after = output.length;
    terminal.write(text);
    return after;
  };
  return {
    key,
    waitFor,
    async openAnswer() {
      await waitFor("waiting");
      expect(stripVTControlCharacters(output)).toContain("unit");
      expect(stripVTControlCharacters(output)).toContain("◇ watching");
      await waitFor("Switch to acting?", key("a"));
      await waitFor("Your answer", key("y"));
      expect(stripVTControlCharacters(output)).toContain("◆ acting");
      expect(stripVTControlCharacters(output)).toContain("unit q1");
    },
    async redraw(text: string) {
      // Ink paints incremental updates; resizing obtains a fresh, complete visible frame.
      const wider = output.length;
      terminal.resize(101, 30);
      await waitFor("foreman", wider);
      const restored = output.length;
      terminal.resize(100, 30);
      await waitFor(text, restored);
      return stripVTControlCharacters(output.slice(restored));
    },
    async quit() {
      key("q");
      const [status] = await Promise.all([child.exited, closed]);
      expect(status, output).toBe(0);
      expect(output).toContain("\x1b[?1049h");
      expect(output.split("\x1b[?1049l")).toHaveLength(2);
      expect(output).not.toContain("Internal error.");
    },
    async close() {
      child.kill();
      await Promise.all([child.exited, closed]);
      terminal.close();
    },
  };
}

async function waitingRun(
  journey: (fixture: {
    run: (args: string[]) => Promise<string>;
    ui: ReturnType<typeof monitor>;
    verifyAnswer: (text: string) => Promise<void>;
  }) => Promise<void>,
) {
  const root = await mkdtemp("/tmp/fm-act-");
  const repo = join(root, "repo");
  const env = {
    HOME: root,
    FOREMAN_HOME: join(root, "d"),
    CODEX_HOME: join(root, "codex"),
    CODEX_BIN: resolve("tests/fixtures/fake-app-server/main.mjs"),
    FAKE_APP_SERVER_SCENARIO: join(root, "scenario.json"),
    FAKE_APP_SERVER_LOG: join(root, "received.jsonl"),
    PATH: `${root}:/usr/bin:/bin`,
    LOG_LEVEL: "none",
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };
  const run = async (args: string[]) => {
    const child = Bun.spawn([binary, ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8_000,
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }, `${args.join(" ")}\n${stdout}`).toEqual({
      status: 0,
      stderr: "",
    });
    return stdout;
  };
  let ui: ReturnType<typeof monitor> | undefined;
  let started = false;
  try {
    await mkdir(repo);
    await symlink(process.execPath, join(root, "node"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git(["init", "-q"]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    const contract = join(root, "contract.md");
    await writeFile(contract, "Ask the orchestrator whether to proceed.");
    await writeFile(
      env.FAKE_APP_SERVER_SCENARIO,
      Schema.encodeSync(Schema.fromJsonString(Scenario))(askOrchestrator()),
    );
    started = true;
    const attention = await run([
      "start",
      "unit",
      "--new-worktree",
      "--contract",
      contract,
      "--write",
      "--wait",
      "--timeout",
      "5s",
    ]);
    expect(attention).toContain("question    unit q1");
    const waiting = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(
      await run(["status", "unit", "--json"]),
    );
    expect(waiting).toMatchObject({
      _tag: "Digests",
      digests: [{ name: "unit", state: "waiting", questions: [{ id: "q1" }] }],
    });
    ui = monitor(repo, env);
    await journey({
      run,
      ui,
      async verifyAnswer(text) {
        const done = await run(["wait", "unit", "--timeout", "5s"]);
        expect(done).toContain("done        unit turn 1");
        const status = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(
          await run(["status", "unit", "--json"]),
        );
        expect(status).toMatchObject({
          _tag: "Digests",
          digests: [{ name: "unit", state: "idle", turn: 1, questions: [] }],
        });
        const events = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(
          await run(["events", "unit", "--json"]),
        );
        if (events._tag !== "Events") throw new Error("Expected run events");
        const resolutions = events.events
          .map(({ event }) => event)
          .filter((e) => e._tag === "QuestionResolved")
          .map(({ id, resolution }) => ({ id: String(id), resolution }));
        expect(resolutions).toEqual([{ id: "q1", resolution: "answered" }]);
        // Status/events omit answer text; the journal and fake's wire log prove exact delivery.
        const questions = (
          await readFile(join(env.FOREMAN_HOME, "runs/unit/questions.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(QuestionLine))(line));
        expect(questions.filter((q) => q._tag === "Resolved")).toMatchObject([
          { id: "q1", resolution: "answered", text },
        ]);
        const wire = (await readFile(env.FAKE_APP_SERVER_LOG, "utf8"))
          .trim()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line));
        const replies = wire.filter(Schema.is(Schema.Struct({ result: ToolCallResponse })));
        expect(replies.map(({ result }) => result)).toEqual([
          { contentItems: [{ type: "inputText", text }], success: true },
        ]);
      },
    });
  } finally {
    try {
      await ui?.close();
      if (started) {
        const status = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(
          await run(["status", "unit", "--json"]),
        );
        expect(status._tag).toBe("Digests");
        if (
          status._tag === "Digests" &&
          status.digests.some((run) => run.questions.some((q) => q.id === "q1"))
        )
          await run(["answer", "unit", "q1", "cleanup", "--wait", "--timeout", "5s"]);
      }
    } finally {
      try {
        await run(["daemon", "stop"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

test("compiled monitor answers through the daemon, counts UTF-8 bytes and returns to watching", async () => {
  await waitingRun(async ({ ui, verifyAnswer }) => {
    await ui.openAnswer();
    const answer = "Proceed café";
    await ui.waitFor(answer, ui.key(answer));
    const notice = `answered unit q1 · ${Buffer.byteLength(answer)} bytes`;
    await ui.waitFor(`unit q1 · ${Buffer.byteLength(answer)} bytes`, ui.key("\r"));
    const frame = await ui.redraw(notice);
    expect(frame).toContain(notice);
    expect(frame).toContain("◆ acting");
    expect(frame).not.toContain("Your answer");
    await ui.waitFor("◇ watching", ui.key("w"));
    await ui.quit();
    await verifyAnswer(answer);
  });
}, 25_000);

test("compiled monitor keeps the answer box and draft when the CLI answers q1 first", async () => {
  await waitingRun(async ({ ui, run, verifyAnswer }) => {
    await ui.openAnswer();
    const draft = "Keep my café draft";
    await ui.waitFor(draft, ui.key(draft));
    await run(["answer", "unit", "q1", "first"]);
    await ui.waitFor("q1 was resolved while you typed; your draft is kept");
    ui.key("\r");
    const frame = await ui.redraw("Your answer");
    expect(frame).toContain("unit q1");
    expect(frame).toContain("Your answer");
    expect(frame).toContain(draft);
    expect(frame).toContain("q1 was resolved while you typed; your draft is kept");
    expect(frame).toContain("◆ acting");
    expect(frame).not.toContain("answered unit q1");
    await verifyAnswer("first");
    await ui.waitFor("a answer", ui.key("\x1b"));
    await ui.waitFor("◇ watching", ui.key("w"));
    await ui.quit();
  });
}, 25_000);
