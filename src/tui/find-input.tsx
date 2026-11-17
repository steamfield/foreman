import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import stringWidth from "string-width";

/** Text changes owned by the filter or command palette. */
export type FindMessage = { readonly type: "filter-text" | "palette-query"; readonly text: string };

function useFindCaret(value: string, onChange: (text: string) => void) {
  const [revision, setRevision] = useState(0);
  const [caret, setCaret] = useState(value.length);
  useInput((_input, key) => {
    if (key.escape || key.ctrl || key.upArrow || key.downArrow) {
      setRevision((current) => current + 1);
      setCaret(value.length);
    } else if (key.leftArrow || key.rightArrow)
      setCaret((current) =>
        Math.max(0, Math.min(value.length, current + (key.leftArrow ? -1 : 1))),
      );
  });
  const change = (text: string) => {
    setCaret((current) => Math.max(0, Math.min(text.length, current + text.length - value.length)));
    onChange(text);
  };
  return { revision, caret, change };
}

/** Keeps text entry separate from list shortcuts and control keys. */
export function FindInput({
  value,
  width,
  onChange,
  onKey,
}: {
  value: string;
  width: number;
  onChange: (text: string) => void;
  onKey: (key: string) => void;
}) {
  const { revision, caret, change } = useFindCaret(value, onChange);
  const viewport = Math.max(1, width);
  const offset = Math.max(0, stringWidth(value.slice(0, caret)) - viewport + 1);
  return (
    <Box width={viewport} height={1} overflow="hidden" contentOffsetX={offset}>
      <Box width={Math.max(viewport, stringWidth(value) + 1)} flexShrink={0}>
        <Text wrap="truncate-end">
          <TextInput
            key={revision}
            value={value}
            onChange={change}
            onSubmit={() => onKey("enter")}
          />
        </Text>
      </Box>
    </Box>
  );
}
