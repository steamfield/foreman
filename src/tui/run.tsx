import { Deferred, Effect, Fiber, Stream } from "effect";
import { render } from "ink";
import type { MonitorFeed } from "../core/monitor/feed";
import { initialState, type Message, reduce, type State, view } from "../core/monitor/model";
import type { Terminal } from "../services/terminal";
import { MonitorApp } from "./screen";
import { theme } from "./theme";

export const runMonitor = Effect.fn("tui.runMonitor")(function* (
  terminal: Terminal["Service"],
  options: Parameters<typeof initialState>[0],
  feed: Stream.Stream<MonitorFeed>,
  noColor: boolean,
) {
  const { stdin, stdout, stderr } = terminal;
  if (stdin === null || stdout === null || stderr === null)
    return yield* Effect.die("Monitor needs terminal streams");
  const done = yield* Deferred.make<"quit" | "interrupt">();
  const colors = theme(undefined, noColor);
  let state: State = initialState(options);
  let model = view(state);
  let instance: ReturnType<typeof render> | undefined;
  const update = (message: Message) => {
    const next = reduce(state, message);
    if (next === state) return;
    state = next;
    model = view(state, model);
    instance?.rerender(frame());
  };
  const onTick = (now: number) => update({ type: "tick", now });
  const onKey = (key: string) => {
    if (key === "q" || key === "ctrl-c")
      Deferred.doneUnsafe(done, Effect.succeed(key === "q" ? "quit" : "interrupt"));
    else update({ type: "key", key });
  };
  const frame = () => <MonitorApp model={model} colors={colors} onKey={onKey} onTick={onTick} />;
  const mounted = yield* Effect.acquireRelease(
    Effect.sync(() => {
      instance = render(frame(), {
        stdin,
        stdout,
        stderr,
        alternateScreen: true,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 10,
        incrementalRendering: true,
      });
      return instance;
    }),
    (app) =>
      Effect.promise(async () => {
        app.unmount();
        await app.waitUntilExit();
        app.cleanup();
      }),
  );
  const updates = feed.pipe(
    Stream.runForEach((value) => Effect.sync(() => update({ type: "feed", value }))),
  );
  const resizes = terminal.resize.pipe(
    Stream.runForEach((size) => Effect.sync(() => update({ type: "resize", ...size }))),
  );
  const input = Effect.promise(async () => {
    await mounted.waitUntilExit();
  });
  const worker = yield* Effect.forkChild(
    Effect.all([updates, resizes, input], { concurrency: "unbounded" }),
  );
  const result = yield* Effect.raceFirst(Deferred.await(done), Fiber.join(worker));
  if (result === "interrupt") return yield* Effect.interrupt;
});
