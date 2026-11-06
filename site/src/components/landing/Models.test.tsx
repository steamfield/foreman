import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { models } from "../../data/landing";
import { loadRun } from "../../data/runs";
import { Models } from "./Models";

test("each Codex card names a run from this page recorded on that model", () => {
  const delegates = models.roles.slice(1);
  expect(delegates.map((role) => role.name)).toEqual(["sol", "terra", "astra"]);
  for (const role of delegates) {
    const run = role.evidence.match(/\((site-[a-z0-9-]+)\)/)?.[1];
    expect(run, role.name).toBeDefined();
    expect(loadRun(run ?? "").model).toBe(role.model);
  }
});

test("server-renders every role with its job and evidence, then the guidance", () => {
  document.body.innerHTML = renderToStaticMarkup(<Models />);
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
  ).toEqual(models.roles.map((role) => role.name));
  for (const role of models.roles) {
    expect(screen.getByText(role.job)).toBeInTheDocument();
    expect(screen.getByText(role.evidence)).toBeInTheDocument();
  }
  expect(document.body.textContent).toContain(".codex/hooks.json");
});

test("renders as a static component with no controls", () => {
  const { container } = render(<Models />);
  expect(container.querySelector("button, script")).toBeNull();
});
