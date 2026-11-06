import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { lifecycleModel } from "../../data/lifecycle";
import { Lifecycle } from "./Lifecycle";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("server HTML contains every detail in order without hidden panels or inert controls", () => {
  const model = lifecycleModel();
  const html = renderToStaticMarkup(<Lifecycle model={model} />);
  const root = document.createElement("div");
  root.innerHTML = html;
  const view = within(root);
  expect(
    view
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(model.nodes.map((node) => node.label));
  expect(view.getAllByRole("listitem")).toHaveLength(10);
  expect(view.queryByRole("tab")).not.toBeInTheDocument();
  expect(root.querySelector("[hidden]")).toBeNull();
  for (const node of model.nodes) {
    if (node.excerpt) expect(root.textContent).toContain(node.excerpt.text);
    expect(root.textContent).toContain(node.command);
  }
});

test("question is selected initially and clicking shows the requested detail with a polite announcement", () => {
  const model = lifecycleModel();
  render(<Lifecycle model={model} />);
  expect(
    screen.getByRole("tab", { name: "Question", selected: true }),
  ).toHaveAttribute("tabindex", "0");
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(
    screen.getByRole("tabpanel", { name: "Question" }).textContent,
  ).toContain(
    model.nodes.find((node) => node.id === "question")?.excerpt?.text,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Done" }));
  expect(screen.getByRole("tabpanel", { name: "Done" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Done details shown.");
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  expect(screen.getByRole("tab", { name: "Question" })).toHaveAttribute(
    "tabindex",
    "-1",
  );
});

test("arrow keys, Home and End move selection and roving focus", () => {
  render(<Lifecycle model={lifecycleModel()} />);
  const list = screen.getByRole("tablist");
  const vertical = list.getAttribute("aria-orientation") === "vertical";
  const question = screen.getByRole("tab", { name: "Question" });
  question.focus();
  fireEvent.keyDown(question, { key: vertical ? "ArrowDown" : "ArrowRight" });
  expect(
    screen.getByRole("tab", { name: "Done", selected: true }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? list, { key: "End" });
  expect(
    screen.getByRole("tab", { name: "Archive", selected: true }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? list, {
    key: vertical ? "ArrowDown" : "ArrowRight",
  });
  expect(
    screen.getByRole("tab", { name: "Contract", selected: true }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? list, {
    key: vertical ? "ArrowUp" : "ArrowLeft",
  });
  expect(
    screen.getByRole("tab", { name: "Archive", selected: true }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? list, { key: "Home" });
  expect(
    screen.getByRole("tab", { name: "Contract", selected: true }),
  ).toHaveFocus();
  expect(
    screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0),
  ).toHaveLength(1);
});

test("the layout follows the viewport and updates the keyboard orientation", () => {
  const media = window.matchMedia("(min-width: 64rem)");
  let wide = false;
  Object.defineProperty(media, "matches", { get: () => wide });
  vi.stubGlobal("matchMedia", () => media);
  render(<Lifecycle model={lifecycleModel()} />);
  expect(screen.getByRole("tablist")).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
  act(() => {
    wide = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(screen.getByRole("tablist")).toHaveAttribute(
    "aria-orientation",
    "horizontal",
  );
  const question = screen.getByRole("tab", { name: "Question" });
  question.focus();
  fireEvent.keyDown(question, { key: "ArrowRight" });
  expect(
    screen.getByRole("tab", { name: "Done", selected: true }),
  ).toHaveFocus();
});

test("archive has no recorded frame when the optional fixture is absent", () => {
  render(<Lifecycle model={lifecycleModel({})} />);
  fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
  const panel = screen.getByRole("tabpanel", { name: "Archive" });
  expect(within(panel).queryByText(/^Recorded CLI/)).not.toBeInTheDocument();
  expect(panel).toHaveTextContent("--keep-worktree");
});

test("larger default text keeps vertical arrow navigation until the rem breakpoint", () => {
  const initialWidth = window.innerWidth;
  const initialFontSize = document.documentElement.style.fontSize;
  // Happy DOM resolves media-query rem units from the document's font size.
  window.innerWidth = 1100;
  document.documentElement.style.fontSize = "20px";
  try {
    render(<Lifecycle model={lifecycleModel()} />);
    expect(screen.getByRole("tablist")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
    const question = screen.getByRole("tab", { name: "Question" });
    question.focus();
    fireEvent.keyDown(question, { key: "ArrowDown" });
    expect(
      screen.getByRole("tab", { name: "Done", selected: true }),
    ).toHaveFocus();
  } finally {
    window.innerWidth = initialWidth;
    document.documentElement.style.fontSize = initialFontSize;
  }
});

test("archive renders the real recording when present", () => {
  const model = lifecycleModel();
  render(<Lifecycle model={model} />);
  fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
  const recording = model.nodes.find((node) => node.id === "archive")?.excerpt;
  if (recording) {
    const panel = screen.getByRole("tabpanel", { name: "Archive" });
    expect(within(panel).getByText(recording.source)).toBeVisible();
    expect(panel.textContent).toContain(recording.text);
  }
});
