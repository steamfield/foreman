import { Deferred, Effect, Fiber, FiberSet, Queue, Stream } from "effect";
import { render, type SuspendTerminal, useApp } from "ink";
import { type ReactNode, useEffect } from "react";
import type { ActMessage, ActState } from "../core/monitor/act";
import type { ActingSession, openActing } from "../core/monitor/acting";
import type { DetailFeed } from "../core/monitor/detail-feed";
import type { MonitorFeed } from "../core/monitor/feed";
import { initialState, type Message, reduce, type State, view } from "../core/monitor/model";
import { type AppError, DaemonUnavailable, detailFor, errorTable } from "../errors";
import type { RunName } from "../schemas/daemon";
import type { Terminal } from "../services/terminal";
import { type EditorRunner, runEditors } from "./editor";
import { MonitorApp } from "./screen";
import { theme } from "./theme";

type ActingOpener = () => ReturnType<typeof openActing>;
type ActRequest = NonNullable<ActState["inFlight"]>;

function TerminalOwner({
  ready,
  children,
}: {
  ready: Deferred.Deferred<SuspendTerminal>;
  children: ReactNode;
}) {
  const { suspendTerminal } = useApp();
  useEffect(() => {
    Deferred.doneUnsafe(ready, Effect.succeed(suspendTerminal));
  }, [ready, suspendTerminal]);
  return children;
}

/** Executes acting intents while owning and observing the session's scoped fiber. */
export const runActing = Effect.fn("tui.runActing")(function* <R>(
  open: ActingOpener,
  requests: Stream.Stream<ActRequest, never, R>,
  dispatch: (message: ActMessage) => void,
) {
  const fibers = yield* FiberSet.make<void, never>();
  let held: Fiber.Fiber<void, never> | undefined;
  let session: ActingSession | undefined;
  let lastId = 0;
  const report = <R2,>(id: number, effect: Effect.Effect<string, AppError, R2>) =>
    effect.pipe(
      Effect.match({
        onFailure: (error) =>
          dispatch({
            type: "act-outcome",
            outcome: { id, ok: false, text: detailFor(error) ?? errorTable[error._tag].message },
          }),
        onSuccess: (text) => dispatch({ type: "act-outcome", outcome: { id, ok: true, text } }),
      }),
    );
  const enter = (id: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* open().pipe(Effect.result);
        if (opened._tag === "Failure") {
          yield* report(id, Effect.fail(opened.failure));
          return;
        }
        session = opened.success;
        yield* report(id, Effect.succeed("acting"));
        yield* session.closed;
        dispatch({ type: "acting-lost", text: "The daemon connection closed; back to watching." });
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          session = undefined;
        }),
      ),
    );
  const execute = (request: ActRequest) =>
    Effect.gen(function* () {
      if (request.id === lastId) return;
      lastId = request.id;
      const { id, intent } = request;
      if (intent.kind === "enter-acting") {
        if (held) yield* Fiber.interrupt(held);
        held = yield* FiberSet.run(fibers, enter(id));
      } else if (intent.kind === "leave-acting") {
        if (held) yield* Fiber.interrupt(held);
        held = undefined;
        yield* report(id, Effect.succeed("watching"));
      } else
        yield* report(
          id,
          session
            ? session.send(intent)
            : Effect.fail(
                new DaemonUnavailable({
                  detail: "The daemon connection closed; back to watching.",
                }),
              ),
        );
    });
  yield* Effect.raceFirst(Stream.runForEach(requests, execute), FiberSet.join(fibers));
}, Effect.scoped);

/** Runs the interactive monitor and releases its terminal and acting session on exit. */
export const runMonitor = Effect.fn("tui.runMonitor")(function* <R>(
  terminal: Terminal["Service"],
  options: Parameters<typeof initialState>[0],
  feed: Stream.Stream<MonitorFeed, never, R>,
  detail: (name: RunName) => Stream.Stream<DetailFeed, never, R>,
  noColor: boolean,
  open: ActingOpener = () => Effect.fail(new DaemonUnavailable()),
  App: typeof MonitorApp = MonitorApp,
  edit: EditorRunner = () => Effect.fail(new Error("No editor runner was provided.")),
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
  const actions = yield* Queue.unbounded<ActRequest>();
  const editors = yield* Queue.unbounded<NonNullable<ActState["editor"]>>();
  const editorTerminal = yield* Deferred.make<SuspendTerminal>();
  yield* Effect.addFinalizer(() => Queue.shutdown(opened));
  yield* Effect.addFinalizer(() => Queue.shutdown(actions));
  yield* Effect.addFinalizer(() => Queue.shutdown(editors));
  Queue.offerUnsafe(opened, state.detail?.name ?? null);
  const update = (message: Message) => {
    const next = reduce(state, message);
    if (next === state) return;
    if (next.detail?.name !== state.detail?.name)
      Queue.offerUnsafe(opened, next.detail?.name ?? null);
    if (next.act.inFlight && next.act.inFlight.id !== state.act.inFlight?.id)
      Queue.offerUnsafe(actions, next.act.inFlight);
    if (next.act.editor && next.act.editor.id !== state.act.editor?.id)
      Queue.offerUnsafe(editors, next.act.editor);
    state = next;
    model = view(state, model);
    instance?.rerender(frame());
  };
  const onTick = (now: number) => update({ type: "tick", now });
  const onKey = (key: string) => {
    if (
      (key === "q" && !model.act.answer && !model.act.confirm && !model.act.compose) ||
      key === "ctrl-c"
    )
      Deferred.doneUnsafe(done, Effect.succeed(key === "q" ? "quit" : "interrupt"));
    else update({ type: "key", key });
  };
  const frame = () => (
    <TerminalOwner ready={editorTerminal}>
      <App model={model} colors={colors} onKey={onKey} onTick={onTick} onAct={update} />
    </TerminalOwner>
  );
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
    Effect.all(
      [
        updates,
        details,
        resizes,
        input,
        runActing(open, Stream.fromQueue(actions), update),
        Deferred.await(editorTerminal).pipe(
          Effect.flatMap((suspend) => runEditors(edit, suspend, Stream.fromQueue(editors), update)),
        ),
      ],
      { concurrency: "unbounded" },
    ),
  );
  const result = yield* Effect.raceFirst(Deferred.await(done), Fiber.join(worker)).pipe(
    Effect.ensuring(Fiber.interrupt(worker)),
  );
  if (result === "interrupt") return yield* Effect.interrupt;
});
