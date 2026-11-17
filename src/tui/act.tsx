import { Box, type DOMElement, Text, useBoxMetrics } from "ink";
import { type ReactNode, useRef } from "react";
import type { ActMessage, ActView } from "../core/monitor/act";
import { FrameContent, FramedParagraph, FramedText, FrameRow, frameHeading } from "./act-frame";
import { AnswerInput } from "./answer-input";
import { Line } from "./components";
import type { ContextAnswer } from "./inspect-view";
import type { Theme } from "./theme";

/** Paints the current watching or acting mode without using the attention tone. */
export function ModeChip({ act, colors }: { act: ActView; colors: Theme }) {
  return colors.paint(act.chip.text, act.chip.mode === "acting" ? "running" : "muted");
}

function Question({
  text,
  width,
  height,
  colors,
}: {
  text: string;
  width: number;
  height: number;
  colors: Theme;
}) {
  const content = useRef<DOMElement | null>(null);
  const clipped = useBoxMetrics(content).height > height;
  return (
    <>
      <FrameRow
        width={width}
        colors={colors}
        maxHeight={Math.max(1, height - Number(clipped))}
        contentRef={content}
      >
        <FrameContent width={width} colors={colors}>
          <Text>{colors.paint(text)}</Text>
        </FrameContent>
      </FrameRow>
      {clipped && <FramedText text="…" width={width} colors={colors} muted />}
    </>
  );
}

function AnswerBox({
  answer,
  width,
  height,
  colors,
  onAct,
  onKey,
}: {
  answer: ContextAnswer;
  width: number;
  height: number;
  colors: Theme;
  onAct: (message: ActMessage) => void;
  onKey: (key: string) => void;
}) {
  const resolved = `${answer.title.trim().split(/\s+/).at(-1)} was resolved while you typed; your draft is kept`;
  let action = `${colors.paint("enter", "fg", true)} send  ${colors.paint("ctrl-d", "fg", true)} defer  ${colors.paint("esc", "fg", true)} cancel`;
  if (answer.resolved) action = resolved;
  if (answer.sending) action = "sending…";
  const contextLimit = Math.max(0, Math.floor((height - 18) / 2));
  const context = contextLimit > 0 ? (answer.context?.slice(-contextLimit) ?? []) : [];
  return (
    <Box flexDirection="column" width={width} maxHeight={height} overflow="hidden">
      <Line width={width} colors={colors}>
        {frameHeading(answer.title, answer.meta, width, colors)}
      </Line>
      <FramedText text="" width={width} colors={colors} />
      <Question
        text={answer.question}
        width={width}
        height={Math.max(1, height - 15 - (context.length ? context.length + 1 : 0))}
        colors={colors}
      />
      <FramedText text="" width={width} colors={colors} />
      {context.length > 0 && (
        <>
          <FramedText
            text={colors.paint("Leading up to it", "fg", true)}
            width={width}
            colors={colors}
          />
          {context
            .map((text, position) => ({ text, id: `context:${position}` }))
            .map(({ text, id }) => (
              <FramedText key={id} text={text} width={width} colors={colors} muted />
            ))}
        </>
      )}
      <FramedText text={colors.paint("Your answer", "fg", true)} width={width} colors={colors} />
      <FrameRow width={width} colors={colors} height={3}>
        <AnswerInput answer={answer} width={width} colors={colors} onAct={onAct} onKey={onKey} />
      </FrameRow>
      <FramedText text="" width={width} colors={colors} />
      <FramedParagraph text={answer.alsoWaiting} width={width} colors={colors} muted />
      <FramedText text="" width={width} colors={colors} />
      <FramedText
        text={action}
        width={width}
        colors={colors}
        muted={answer.sending || answer.resolved}
      />
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(width - 2)}╯`, "fg")}
      </Line>
    </Box>
  );
}

function ComposeBox({
  compose,
  width,
  colors,
  onAct,
  onKey,
}: {
  compose: NonNullable<ActView["compose"]>;
  width: number;
  colors: Theme;
  onAct: (message: ActMessage) => void;
  onKey: (key: string) => void;
}) {
  const action = compose.sending
    ? "sending…"
    : [
        ["enter", "send"],
        ["ctrl-e", "$EDITOR"],
        ["esc", "cancel"],
      ]
        .map(([key, label]) => `${colors.paint(key ?? "", "fg", true)} ${label}`)
        .join("  ");
  return (
    <Box flexDirection="column" width={width}>
      <Line width={width} colors={colors}>
        {frameHeading(compose.title, compose.meta, width, colors, false)}
      </Line>
      <FramedText text="" width={width} colors={colors} />
      <FrameRow width={width} colors={colors} height={3}>
        <AnswerInput answer={compose} width={width} colors={colors} onAct={onAct} onKey={onKey} />
      </FrameRow>
      <FramedText text="" width={width} colors={colors} />
      <FramedText text={action} width={width} colors={colors} muted={compose.sending} />
      <Line width={width} colors={colors}>
        {colors.paint(`╰${"─".repeat(width - 2)}╯`, "fg")}
      </Line>
    </Box>
  );
}

/** Draws the acting overlay in the centre of the available list or detail area. */
export function ActOverlay({
  act,
  columns,
  height,
  colors,
  onAct,
  onKey,
}: {
  act: ActView;
  columns: number;
  height: number;
  colors: Theme;
  onAct: (message: ActMessage) => void;
  onKey: (key: string) => void;
}) {
  const width = Math.max(8, Math.min(104, columns - 4));
  let box: ReactNode = null;
  if (act.answer)
    box = (
      <AnswerBox
        answer={act.answer}
        width={width}
        height={height}
        colors={colors}
        onAct={onAct}
        onKey={onKey}
      />
    );
  else if (act.compose)
    box = (
      <ComposeBox compose={act.compose} width={width} colors={colors} onAct={onAct} onKey={onKey} />
    );
  else if (act.confirm)
    box = (
      <Box width={width} flexDirection="column">
        <Line width={width} colors={colors}>
          {frameHeading(act.confirm.title, "", width, colors, false)}
        </Line>
        <FramedText text="" width={width} colors={colors} />
        {act.confirm.lines
          .filter(
            (text) =>
              text.trim().replace(/\s+/g, " ") !==
              act.confirm?.keys.map(({ key, label }) => `${key} ${label}`).join(" "),
          )
          .map((text) => (
            <FramedParagraph key={text} text={text} width={width} colors={colors} />
          ))}
        <FramedText text="" width={width} colors={colors} />
        <FramedText
          text={act.confirm.keys
            .map(({ key, label }, index) =>
              index === 0
                ? colors.select(colors.paint(` ${key} ${label} `, "fg", true))
                : `${colors.paint(key, "fg", true)} ${label}`,
            )
            .join("  ")}
          width={width}
          colors={colors}
        />
        <Line width={width} colors={colors}>
          {colors.paint(`╰${"─".repeat(width - 2)}╯`, "fg")}
        </Line>
      </Box>
    );
  return (
    <Box
      position="absolute"
      width={columns}
      height={height}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
    >
      {box}
    </Box>
  );
}

/** Shows the last action outcome directly above the footer. */
export function ActNotice({ act, width, colors }: { act: ActView; width: number; colors: Theme }) {
  if (!act.notice) return null;
  return (
    <Line width={width} colors={colors}>
      {colors.paint(
        `${act.notice.ok ? "✓" : "×"} ${act.notice.text}`,
        act.notice.ok ? "done" : "failed",
      )}
    </Line>
  );
}
