import type { ReactNode } from "react";
import type { Scene, Session, SessionState } from "../../../data/session";
import "./session.css";

type Box = { x: number; y: number; w: number; h: number };
type Port = { x: number; y: number; dx: number; dy: number };
type Geometry = {
  width: number;
  height: number;
  compact: boolean;
  claude: Box;
  board: Box;
  agent: (i: number) => Box;
};
const WIDE: Geometry = {
  width: 1120,
  height: 550,
  compact: false,
  claude: { x: 16, y: 170, w: 240, h: 176 },
  board: { x: 372, y: 120, w: 310, h: 310 },
  agent: (i) => ({ x: 820, y: 16 + i * 178, w: 284, h: 162 }),
};
const TALL: Geometry = {
  width: 360,
  height: 1080,
  compact: true,
  claude: { x: 12, y: 12, w: 336, h: 118 },
  board: { x: 12, y: 210, w: 336, h: 310 },
  agent: (i) => ({ x: 60, y: 560 + i * 174, w: 288, h: 162 }),
};

const stateFill: Record<SessionState, string> = {
  queued: "fill-ink-3",
  starting: "fill-console-muted",
  running: "fill-state-running",
  waiting: "fill-signal",
  done: "fill-state-done",
  archived: "fill-console-muted",
};
// Activity colors per state: a tinted card, a stronger border, and (while
// playing) a segment tracing the border. Done and idle cards stay plain.
type Activity = { tint: string; stroke: string; trace: string };
const activity: Partial<Record<SessionState, Activity>> = {
  starting: {
    tint: "fill-state-running/10",
    stroke: "stroke-state-running-ink",
    trace: "stroke-state-running-ink",
  },
  running: {
    tint: "fill-state-running/10",
    stroke: "stroke-state-running-ink",
    trace: "stroke-state-running-ink",
  },
  waiting: {
    tint: "fill-signal/15",
    stroke: "stroke-signal",
    trace: "stroke-signal",
  },
};

/** A card's activity layers: pulsing tint, then the tracing border segment. */
function ActiveCard({
  box,
  look,
  playing,
}: {
  box: Box;
  look: Activity;
  playing: boolean;
}) {
  const rect = { x: box.x, y: box.y, width: box.w, height: box.h, rx: 6 };
  return (
    <>
      <rect {...rect} className={`session-tint ${look.tint}`} stroke="none" />
      {playing && (
        <rect
          {...rect}
          pathLength={100}
          fill="none"
          strokeWidth={2.5}
          strokeLinecap="round"
          className={`session-trace ${look.trace}`}
        />
      )}
    </>
  );
}

const short = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

function Text({
  x,
  y,
  children,
  className = "fill-ink",
  mono = false,
  size = 13,
}: {
  x: number;
  y: number;
  children: ReactNode;
  className?: string;
  mono?: boolean;
  size?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      className={`${mono ? "font-mono" : "font-sans"} ${className}`}
    >
      {children}
    </text>
  );
}

function curve(a: Port, b: Port, maxReach = Infinity) {
  const reach = Math.min(
    maxReach,
    Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 0.5,
  );
  const c = { x: a.x + a.dx * reach, y: a.y + a.dy * reach };
  const d = { x: b.x + b.dx * reach, y: b.y + b.dy * reach };
  return {
    path: `M${a.x} ${a.y} C${c.x} ${c.y} ${d.x} ${d.y} ${b.x} ${b.y}`,
    at: (u: number) => ({
      x:
        (1 - u) ** 3 * a.x +
        3 * (1 - u) ** 2 * u * c.x +
        3 * (1 - u) * u * u * d.x +
        u ** 3 * b.x,
      y:
        (1 - u) ** 3 * a.y +
        3 * (1 - u) ** 2 * u * c.y +
        3 * (1 - u) * u * u * d.y +
        u ** 3 * b.y,
    }),
  };
}

function link(g: Geometry, agent?: number) {
  if (agent === undefined)
    return g.compact
      ? curve(
          { x: 180, y: 130, dx: 0, dy: 1 },
          { x: 180, y: 210, dx: 0, dy: -1 },
        )
      : curve(
          { x: 256, y: 258, dx: 1, dy: 0 },
          { x: 372, y: 258, dx: -1, dy: 0 },
        );
  const box = g.agent(agent);
  return g.compact
    ? curve(
        { x: 28, y: 520, dx: 0, dy: 1 },
        { x: box.x, y: box.y + 80, dx: -1, dy: 0 },
        48,
      )
    : curve(
        { x: 682, y: 184 + agent * 62, dx: 1, dy: 0 },
        { x: box.x, y: box.y + 80, dx: -1, dy: 0 },
      );
}

function Drawing({
  g,
  session,
  scene,
  playing,
}: {
  g: Geometry;
  session: Session;
  scene: Scene;
  playing: boolean;
}) {
  const board = g.board;
  const claude = g.claude;
  // A link is busy while a packet travels it (key -1 is Claude to the daemon);
  // the value says whether that packet moves along the path or against it.
  const busy = new Map(
    scene.packets.map((p) =>
      typeof p.from === "number"
        ? [p.from, false]
        : typeof p.to === "number"
          ? [p.to, p.from === "daemon"]
          : [-1, p.from === "claude"],
    ),
  );
  const links = [-1, ...session.delegates.map((_, i) => i)];
  return (
    <>
      <g fill="none" className="stroke-line-strong">
        {links.map((i) => (
          <path key={i} d={link(g, i < 0 ? undefined : i).path} />
        ))}
      </g>
      {playing && (
        <g fill="none" className="stroke-ink" strokeWidth={1.5}>
          {links
            .filter((i) => busy.has(i))
            .map((i) => (
              <path
                key={i}
                data-link-busy={i < 0 ? "claude" : session.delegates[i]?.name}
                d={link(g, i < 0 ? undefined : i).path}
                className={
                  busy.get(i)
                    ? "session-flow"
                    : "session-flow session-flow-back"
                }
                strokeDasharray="4 6"
              />
            ))}
        </g>
      )}
      <rect
        data-session-card="claude"
        data-activity={scene.claudeActive ? "active" : "idle"}
        {...{ x: claude.x, y: claude.y, width: claude.w, height: claude.h }}
        rx="6"
        className={`fill-card ${scene.claudeActive ? "stroke-ink" : "stroke-line-strong"}`}
      />
      {scene.claudeActive && (
        <ActiveCard
          box={claude}
          playing={playing}
          look={{ tint: "fill-ink/5", stroke: "", trace: "stroke-ink" }}
        />
      )}
      <Text
        x={claude.x + 16}
        y={claude.y + 30}
        size={19}
        className="fill-ink font-semibold"
      >
        Claude Code
      </Text>
      <Text x={claude.x + 16} y={claude.y + 52} className="fill-ink-3">
        Orchestrator
      </Text>
      <Text
        x={claude.x + 16}
        y={claude.y + 82}
        mono
        className={scene.held ? "fill-signal-text" : "fill-ink"}
      >
        {scene.claude}
      </Text>
      {!g.compact && (
        <>
          <Text
            x={claude.x + 16}
            y={claude.y + 120}
            mono
            size={12}
            className="fill-ink-3"
          >
            console.md · commands.md
          </Text>
          <Text
            x={claude.x + 16}
            y={claude.y + 140}
            mono
            size={12}
            className="fill-ink-3"
          >
            e2e.md
          </Text>
          <Text
            x={claude.x + 16}
            y={claude.y + 160}
            size={12}
            className="fill-ink-3"
          >
            One contract per worktree
          </Text>
        </>
      )}

      <rect
        data-session-card="daemon"
        x={board.x}
        y={board.y}
        width={board.w}
        height={board.h}
        rx="6"
        className="fill-console stroke-console-line"
      />
      <Text
        x={board.x + 16}
        y={board.y + 30}
        size={19}
        className="fill-console-fg font-semibold"
      >
        foreman
      </Text>
      <Text
        x={board.x + 106}
        y={board.y + 29}
        mono
        size={12}
        className="fill-console-muted"
      >
        daemon / dispatch board
      </Text>
      {session.delegates.map((d, i) => {
        const view = scene.delegates[i];
        if (!view) return null;
        const y = board.y + 64 + i * 62;
        const live = activity[view.state];
        return (
          <g key={d.name}>
            <path
              d={`M${board.x + 16} ${y - 17}H${board.x + board.w - 16}`}
              className="stroke-console-line"
            />
            {live && (
              <rect
                data-board-row={d.name}
                x={board.x + 8}
                y={y - 16}
                width={board.w - 16}
                height={44}
                rx="2"
                className={`session-tint ${view.state === "waiting" ? "fill-signal/20" : "fill-state-running/15"}`}
              />
            )}
            <rect
              x={board.x + 16}
              y={y - 8}
              width="6"
              height="6"
              rx="2"
              className={`${stateFill[view.state]} ${playing && view.state === "waiting" ? "state-waiting" : ""}`}
            />
            <Text x={board.x + 30} y={y} mono className="fill-console-fg">
              {d.name}
            </Text>
            <Text
              x={board.x + board.w - 82}
              y={y}
              mono
              size={12}
              className={
                view.state === "waiting" ? "fill-signal" : "fill-console-muted"
              }
            >
              {view.state}
            </Text>
            <Text
              x={board.x + 30}
              y={y + 21}
              mono
              size={12}
              className="fill-console-muted"
            >
              {d.model} · turn {view.turn}
            </Text>
          </g>
        );
      })}
      <rect
        x={board.x + 16}
        y={board.y + 242}
        width={board.w - 32}
        height="50"
        rx="2"
        className={
          scene.held ? "fill-signal" : "fill-console-2 stroke-console-line"
        }
      />
      <Text
        x={board.x + 26}
        y={board.y + 262}
        mono
        size={12}
        className={scene.held ? "fill-signal-ink" : "fill-console-muted"}
      >
        {scene.held
          ? `Held call · site-commands · ${session.question.id}`
          : "Held call · empty"}
      </Text>
      <Text
        x={board.x + 26}
        y={board.y + 280}
        mono
        size={12}
        className={scene.held ? "fill-signal-ink" : "fill-console-muted"}
      >
        {scene.held
          ? short(session.question.text, g.compact ? 39 : 35)
          : "ask_orchestrator → answer"}
      </Text>

      {session.delegates.map((d, i) => {
        const box = g.agent(i);
        const view = scene.delegates[i];
        if (!view) return null;
        const empty = view.state === "archived";
        const chipWidth = d.model.length * 7.2 + 12;
        const event = view.latest;
        const eventLabel =
          event?.kind === "command"
            ? `${event.exitCode === 0 ? "✓" : event.exitCode === null ? "…" : "✗"} ${event.command}`
            : event?.kind === "files"
              ? `write ${event.paths.at(-1) ?? ""}`
              : "Awaiting recorded activity";
        const live = activity[view.state];
        return (
          <g key={d.name}>
            <rect
              data-session-card={d.name}
              data-activity={live ? view.state : "idle"}
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              rx="6"
              className={`fill-card ${live?.stroke ?? (view.state === "done" ? "stroke-state-done-ink" : "stroke-line-strong")}`}
              strokeDasharray={empty ? "4 4" : undefined}
            />
            {live && <ActiveCard box={box} look={live} playing={playing} />}
            <Text
              x={box.x + 14}
              y={box.y + 25}
              mono
              className="fill-ink font-semibold"
            >
              {d.name}
            </Text>
            {empty ? (
              <>
                <Text x={box.x + 14} y={box.y + 72} className="fill-ink-3">
                  Worktree removed
                </Text>
                <Text x={box.x + 14} y={box.y + 94} className="fill-ink-3">
                  Merged branch removed
                </Text>
              </>
            ) : (
              <>
                <Text
                  x={box.x + 14}
                  y={box.y + 46}
                  mono
                  size={12}
                  className="fill-ink-3"
                >
                  {d.branch}
                </Text>
                <rect
                  x={box.x + 14}
                  y={box.y + 58}
                  width={chipWidth}
                  height="20"
                  rx="2"
                  className="fill-band"
                />
                <Text x={box.x + 20} y={box.y + 72} mono size={12}>
                  {d.model}
                </Text>
                <rect
                  x={box.x + chipWidth + 26}
                  y={box.y + 64}
                  width="6"
                  height="6"
                  rx="2"
                  className={`${stateFill[view.state]} ${playing && view.state === "waiting" ? "state-waiting" : ""}`}
                />
                <Text x={box.x + chipWidth + 40} y={box.y + 72} mono size={12}>
                  {view.state}
                </Text>
                <Text
                  x={box.x + 14}
                  y={box.y + 102}
                  size={12}
                  className="fill-ink-2"
                >
                  {d.work}
                </Text>
                <Text x={box.x + 14} y={box.y + 124} mono size={12}>
                  {view.commands} commands · {view.files} files written
                </Text>
                <Text
                  x={box.x + 14}
                  y={box.y + 147}
                  mono
                  size={12}
                  className={
                    event?.kind === "command"
                      ? event.exitCode === 0
                        ? "fill-state-done-ink"
                        : event.exitCode === null
                          ? "fill-ink-3"
                          : "fill-state-failed-ink"
                      : "fill-ink-3"
                  }
                >
                  {short(eventLabel, 34)}
                </Text>
              </>
            )}
          </g>
        );
      })}
      {scene.packets.map((packet, i) => {
        const agent =
          typeof packet.from === "number"
            ? packet.from
            : typeof packet.to === "number"
              ? packet.to
              : undefined;
        const forward =
          agent === undefined
            ? packet.from === "claude"
            : packet.from === "daemon";
        const at = link(g, agent).at(
          forward ? packet.progress : 1 - packet.progress,
        );
        const width = packet.label.length * 7.2 + 16;
        // Keep wide labels inside the link's gap throughout the flight, even
        // when the label is wider than the remaining distance to a card.
        const left = g.compact
          ? 0
          : agent === undefined
            ? claude.x + claude.w
            : board.x + board.w;
        const right = g.compact
          ? g.width
          : agent === undefined
            ? board.x
            : g.agent(agent).x;
        const x = Math.max(
          left + width / 2 + 2,
          Math.min(right - width / 2 - 2, at.x),
        );
        // Phone delegate links run down a narrow gutter. Turn their labels with
        // the path so a full command fits beside the cards instead of over them.
        const vertical = g.compact && agent !== undefined;
        const label: Box = vertical
          ? { x: Math.max(4, at.x - 30), y: at.y - width - 8, w: 22, h: width }
          : { x: x - width / 2, y: at.y - 30, w: width, h: 22 };
        const clearance = Math.min(
          ...[
            claude,
            board,
            ...session.delegates.map((_, i) => g.agent(i)),
          ].map((card) =>
            Math.max(
              card.x - label.x - label.w,
              label.x - card.x - card.w,
              card.y - label.y - label.h,
              label.y - card.y - card.h,
            ),
          ),
        );
        const opacity = Math.max(
          0,
          Math.min(
            1,
            packet.progress / 0.15,
            (1 - packet.progress) / 0.15,
            clearance / 2,
          ),
        );
        return (
          <g key={`${packet.label}-${i}`}>
            <rect
              x={at.x - 3}
              y={at.y - 3}
              width="6"
              height="6"
              className={packet.attention ? "fill-signal" : "fill-ink"}
            />
            {opacity > 0 && (
              <g opacity={opacity}>
                <rect
                  data-packet-label={packet.label}
                  x={label.x}
                  y={label.y}
                  width={label.w}
                  height={label.h}
                  rx="2"
                  className={
                    packet.attention
                      ? "fill-signal"
                      : "fill-card stroke-line-strong"
                  }
                />
                <g
                  transform={
                    vertical
                      ? `translate(${label.x + 15} ${label.y + label.h - 8}) rotate(-90)`
                      : undefined
                  }
                >
                  <Text
                    x={vertical ? 0 : label.x + 8}
                    y={vertical ? 0 : label.y + 15}
                    mono
                    size={12}
                  >
                    {packet.label}
                  </Text>
                </g>
              </g>
            )}
          </g>
        );
      })}
    </>
  );
}

export function SessionCanvas({
  session,
  scene,
  playing,
}: {
  session: Session;
  scene: Scene;
  playing: boolean;
}) {
  // Normalize both geometries into one viewBox. CSS restores their aspect ratios,
  // including before hydration, so the no-JS phone layout uses the tall drawing.
  return (
    <svg
      viewBox="0 0 1120 1120"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-playing={playing || undefined}
      className="session-canvas mx-auto block w-full max-w-md lg:max-w-none"
    >
      <g className="session-wide" transform={`scale(1 ${1120 / WIDE.height})`}>
        <Drawing g={WIDE} session={session} scene={scene} playing={playing} />
      </g>
      <g
        className="session-tall"
        transform={`scale(${1120 / TALL.width} ${1120 / TALL.height})`}
      >
        <Drawing g={TALL} session={session} scene={scene} playing={playing} />
      </g>
    </svg>
  );
}
