import { Box, type DOMElement, Text, useBoxMetrics, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import type { ActMessage, ActView } from "../core/monitor/act";
import { FrameContent } from "./act-frame";
import type { Theme } from "./theme";

/** Keeps the widget's caret visible in its three-row answer viewport. */
export function AnswerInput({
  answer,
  width,
  colors,
  onAct,
  onKey,
}: {
  answer: NonNullable<ActView["compose"]> & { readonly resolved?: boolean };
  width: number;
  colors: Theme;
  onAct: (message: ActMessage) => void;
  onKey: (key: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [caret, setCaret] = useState(answer.draft.length);
  const prefix = useRef<DOMElement | null>(null);
  const metrics = useBoxMetrics(prefix);
  useInput((input, key) => {
    // ink-text-input advances its private cursor for controls even if onChange is ignored.
    if (key.escape || (key.ctrl && ["s", "d", "e", "c"].includes(input))) {
      setRevision((value) => value + 1);
      setCaret(answer.draft.length);
    } else if (key.leftArrow || key.rightArrow)
      setCaret((value) =>
        Math.max(0, Math.min(answer.draft.length, value + (key.leftArrow ? -1 : 1))),
      );
  });
  return (
    <Box flexDirection="column" width={width - 4}>
      <Box height={0} overflow="hidden">
        <Box ref={prefix} position="absolute" width={width - 4} flexShrink={0}>
          <Text>{`${answer.draft.slice(0, caret)} `}</Text>
        </Box>
      </Box>
      <Box height={3} overflowY="hidden" contentOffsetY={Math.max(0, metrics.height - 2)}>
        <FrameContent width={width} colors={colors}>
          <Text>
            <TextInput
              key={revision}
              value={answer.draft}
              focus={!answer.sending}
              onChange={(text) => {
                setCaret((value) =>
                  Math.max(0, Math.min(text.length, value + text.length - answer.draft.length)),
                );
                onAct({ type: "draft", text });
              }}
              onSubmit={() => {
                if (!answer.sending && !answer.resolved) onKey("enter");
              }}
            />
            {"\n\n"}
          </Text>
        </FrameContent>
      </Box>
    </Box>
  );
}
