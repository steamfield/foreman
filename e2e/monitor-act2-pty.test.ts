import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Schema } from "effect";
import { Method, TurnStartParams, TurnSteerParams } from "../src/schemas/codex";
import { DaemonResult } from "../src/schemas/daemon";
import { Scenario } from "../tests/fixtures/fake-app-server/scenario";
import { interruptedTurn } from "../tests/fixtures/fake-app-server/scenarios";

const binary = resolve("dist/foreman");
const interruptedRow = /\bunit\s+(?:\S+ · \S+\s+)?interrupted\b/;

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
  const waitFor = async (text: string | RegExp, after = 0) => {
    let notify = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          notify = () => {
            const raw = output.slice(after);
            if (!raw.endsWith("\x1b[?2026l")) return;
            const frame = stripVTControlCharacters(raw);
            if (typeof text === "string" ? frame.includes(text) : text.test(frame)) resolve();
          };
          listeners.add(notify);
          notify();
          timer = setTimeout(
            () => reject(new Error(`No frame matching ${String(text)}:\n${output}`)),
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
    async redraw(text: string | RegExp) {
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

// The stock scenario waits on a question. Keep these turns running instead, so s is eligible,
// and repeat turn/start so the same thread can accept the interrupted turn's follow-up.
function openTurns(): Scenario {
  return {
    rules: interruptedTurn().rules.map((rule) =>
      rule.method === Method.turnStart
        ? {
            ...rule,
            repeat: true,
            steps: [
              {
                notify: Method.turnStarted,
                params: {
                  threadId: "{{thread}}",
                  turn: { id: "{{turn}}", status: "inProgress", items: [], error: null },
                },
              },
              { awaitRequest: Method.turnInterrupt },
              {
                notify: Method.turnCompleted,
                params: {
                  threadId: "{{thread}}",
                  turn: { id: "{{turn}}", status: "interrupted", items: [], error: null },
                },
              },
            ],
          }
        : { ...rule, repeat: true },
    ),
  };
}

async function runningRun(
  journey: (fixture: {
    run: (args: string[]) => Promise<string>;
    ui: ReturnType<typeof monitor>;
    untilState: (state: "running" | "interrupted", turn: number) => Promise<void>;
    requests: (method: string) => Promise<unknown[]>;
  }) => Promise<void>,
) {
  const root = await mkdtemp("/tmp/fm-act2-");
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
  const status = async () =>
    Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(
      await run(["status", "unit", "--json"]),
    );
  const untilState = async (state: "running" | "interrupted", turn: number) => {
    const deadline = Date.now() + 5_000;
    while (true) {
      const result = await status();
      if (
        result._tag === "Digests" &&
        result.digests[0]?.state === state &&
        result.digests[0]?.turn === turn
      )
        return;
      if (Date.now() >= deadline)
        throw new Error(`Expected unit ${state} turn ${turn}: ${JSON.stringify(result)}`);
    }
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
    await writeFile(contract, "Keep working until interrupted; accept steers and follow-ups.");
    await writeFile(
      env.FAKE_APP_SERVER_SCENARIO,
      Schema.encodeSync(Schema.fromJsonString(Scenario))(openTurns()),
    );
    started = true;
    await run(["start", "unit", "--new-worktree", "--contract", contract, "--write"]);
    await untilState("running", 1);
    ui = monitor(repo, env);
    await ui.waitFor("running");
    const frame = await ui.redraw("◇ watching");
    expect(frame).toContain("unit");
    await journey({
      run,
      ui,
      untilState,
      async requests(method) {
        const Message = Schema.Struct({
          method: Schema.optionalKey(Schema.String),
          params: Schema.optionalKey(Schema.Unknown),
        });
        return (await readFile(env.FAKE_APP_SERVER_LOG, "utf8"))
          .trim()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Message))(line))
          .filter((message) => message.method === method)
          .map((message) => message.params);
      },
    });
  } finally {
    try {
      await ui?.close();
      if (started) {
        const result = await status();
        if (
          result._tag === "Digests" &&
          result.digests.some((run) => ["starting", "running", "waiting"].includes(run.state))
        ) {
          await run(["interrupt", "unit"]);
          const turn = result.digests[0]?.turn;
          if (turn !== undefined) await untilState("interrupted", turn);
        }
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

test("compiled monitor steers, interrupts with attribution, then follows up on the same run", async () => {
  await runningRun(async ({ ui, run, untilState, requests }) => {
    // The running header also contains ■; it must not satisfy the interrupted-row wait.
    expect(await ui.redraw("running")).not.toMatch(interruptedRow);
    await ui.waitFor("Switch to acting?", ui.key("s"));
    await ui.waitFor("steer unit", ui.key("y"));
    const steer = "Focus on café";
    await ui.waitFor(steer, ui.key(steer));
    const notice = `steered unit · ${Buffer.byteLength(steer)} bytes`;
    await ui.waitFor(notice, ui.key("\r"));
    expect(await ui.redraw(notice)).toContain("◆ acting");
    const steers = (await requests(Method.turnSteer)).map((params) =>
      Schema.decodeUnknownSync(TurnSteerParams)(params),
    );
    expect(steers).toHaveLength(1);
    expect(steers[0]?.input).toEqual([{ type: "text", text: steer }]);

    await ui.waitFor("Interrupt unit?", ui.key("i"));
    await ui.waitFor("interrupted unit", ui.key("y"));
    await untilState("interrupted", 1);
    const interrupted = Schema.decodeUnknownSync(Schema.fromJsonString(DaemonResult))(
      await run(["status", "unit", "--json"]),
    );
    expect(interrupted).toMatchObject({
      _tag: "Digests",
      digests: [{ name: "unit", state: "interrupted", turn: 1, interruptedBy: "monitor" }],
    });
    expect(await run(["status", "unit"])).toContain("from foreman monitor");
    expect(await requests(Method.turnInterrupt)).toHaveLength(1);

    // Wait for the monitor's feed as well as CLI status before opening follow-up.
    await ui.redraw(interruptedRow);
    await ui.waitFor("follow up unit", ui.key("F"));
    const followup = "Continue with the café checks";
    await ui.waitFor(followup, ui.key(followup));
    await ui.waitFor("followed up unit", ui.key("\r"));
    await untilState("running", 2);
    const turns = (await requests(Method.turnStart)).map((params) =>
      Schema.decodeUnknownSync(TurnStartParams)(params),
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]?.input).toEqual([{ type: "text", text: followup }]);
    expect(turns[1]?.threadId).toBe(turns[0]?.threadId);
    await ui.quit();
  });
}, 25_000);

test.each([
  ["n", "n"],
  ["escape", "\x1b"],
])(
  "compiled monitor cancels interrupt with %s and keeps the turn running",
  async (_name, cancel) => {
    await runningRun(async ({ ui, untilState, requests }) => {
      await ui.waitFor("Switch to acting?", ui.key("i"));
      await ui.waitFor("Interrupt unit?", ui.key("y"));
      await ui.waitFor("i interrupt", ui.key(cancel));
      const frame = await ui.redraw("◆ acting");
      expect(frame).toContain("running");
      expect(frame).not.toContain("Interrupt unit?");

      // A successful steer is a round trip after cancellation, without a timing-based absence check.
      await ui.waitFor("steer unit", ui.key("s"));
      const steer = "Keep working after cancel";
      await ui.waitFor(steer, ui.key(steer));
      await ui.waitFor(`steered unit · ${Buffer.byteLength(steer)} bytes`, ui.key("\r"));
      await untilState("running", 1);
      expect(await requests(Method.turnInterrupt)).toEqual([]);
      expect(await requests(Method.turnStart)).toHaveLength(1);
      const steers = (await requests(Method.turnSteer)).map((params) =>
        Schema.decodeUnknownSync(TurnSteerParams)(params),
      );
      expect(steers).toHaveLength(1);
      expect(steers[0]?.input).toEqual([{ type: "text", text: steer }]);
      await ui.quit();
    });
  },
  25_000,
);
