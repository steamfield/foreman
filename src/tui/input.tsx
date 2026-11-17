import { useInput } from "ink";
import type { ViewModel } from "../core/monitor/model-types";

/** Routes monitor shortcuts before the answer widget receives text input. */
export function MonitorInput({
  model,
  onKey,
  blocked,
}: {
  model: ViewModel;
  onKey: (key: string) => void;
  blocked: { current: boolean };
}) {
  useInput((input, key) => {
    blocked.current = key.escape || key.ctrl;
    if ((model.filterBar?.editing || model.palette || model.feedTabs?.editing) && !model.overlay) {
      blocked.current ||= key.upArrow || key.downArrow;
      if (key.ctrl && input === "c") onKey("ctrl-c");
      else if (key.escape) onKey("escape");
      else if (model.palette && key.upArrow) onKey("up");
      else if (model.palette && key.downArrow) onKey("down");
      return;
    }
    if (model.act.answer || model.act.compose) {
      if (key.ctrl && input === "c") onKey("ctrl-c");
      else if (key.escape) onKey("escape");
      else if (key.ctrl && input === "s") onKey("ctrl-s");
      else if (key.ctrl && input === "d") onKey("ctrl-d");
      else if (key.ctrl && input === "e") onKey("ctrl-e");
      return;
    }
    if (key.ctrl && input === "c") onKey("ctrl-c");
    else if (key.upArrow) onKey("up");
    else if (key.downArrow) onKey("down");
    else if (key.pageUp) onKey("page-up");
    else if (key.pageDown) onKey("page-down");
    else if (key.return) onKey("enter");
    else if (key.escape) onKey("escape");
    else if (key.home) onKey("home");
    else if (key.end) onKey("end");
    else if (key.tab) onKey("tab");
    else onKey(input);
  });
  return null;
}
