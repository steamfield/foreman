import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { render } from "ink";
import type { DetailFeed } from "../core/monitor/detail-feed";
import type { MonitorFeed } from "../core/monitor/feed";
import { initialState, type Message, reduce, type State, view } from "../core/monitor/model";
import type { RunName } from "../schemas/daemon";
import type { Terminal } from "../services/terminal";
import { MonitorApp } from "./screen";
import { theme } from "./theme";

export const runMonitor = Effect.fn("tui.runMonitor")(function* <R>(
  terminal: Terminal["Service"],
  options: Parameters<typeof initialState>[0],
  feed: Stream.Stream<MonitorFeed, never, R>,
  detail: (name: RunName) => Stream.Stream<DetailFeed, never, R>,
  noColor: boolean,
  App: typeof MonitorApp = MonitorApp,
) {
  const { stdin, stdout, stderr } = terminal;
  if (stdin === null || stdout === null || stderr === null)
    return yield* Effect.die("Monitor needs terminal streams");
  const done = yield* Deferred.make<"quit" | "interrupt">();
  const colors = theme(undefined, noColor);
  let state: State = initialState(options);
  let model = view(state);
  let instance: ReturnType<typeof render> | undefined;
  const opened = yield* Queue.unbounded<RunName | null>();
  yield* Effect.addFinalizer(() => Queue.shutdown(opened));
  Queue.offerUnsafe(opened, state.detail?.name ?? null);
  const update = (message: Message) => {
    const next = reduce(state, message);
    if (next === state) return;
    if (next.detail?.name !== state.detail?.name)
      Queue.offerUnsafe(opened, next.detail?.name ?? null);
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
  const frame = () => <App model={model} colors={colors} onKey={onKey} onTick={onTick} />;
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
        try {
          app.unmount();
          // The input effect owns render failures; teardown must still finish.
          await app.waitUntilExit().catch(() => undefined);
        } finally {
          app.cleanup();
        }
      }),
  );
  const updates = feed.pipe(
    Stream.runForEach((value) => Effect.sync(() => update({ type: "feed", value }))),
  );
  const resizes = terminal.resize.pipe(
    Stream.runForEach((size) => Effect.sync(() => update({ type: "resize", ...size }))),
  );
  const details = Stream.fromQueue(opened).pipe(
    Stream.switchMap((name) =>
      name === null
        ? Stream.empty
        : detail(name).pipe(
            Stream.tap((value) => Effect.sync(() => update({ type: "detail-feed", name, value }))),
          ),
    ),
    Stream.runDrain,
  );
  const input = Effect.tryPromise({
    try: () => mounted.waitUntilExit(),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("monitor.render.failed").pipe(Effect.andThen(Effect.die(error))),
    ),
  );
  const worker = yield* Effect.forkChild(
    Effect.all([updates, details, resizes, input], { concurrency: "unbounded" }),
  );
  const result = yield* Effect.raceFirst(Deferred.await(done), Fiber.join(worker));
  if (result === "interrupt") return yield* Effect.interrupt;
});
