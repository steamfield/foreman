import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import catalog from "../../../fixtures/cli/models.json";
import { models } from "../../data/landing";
import { loadRun } from "../../data/runs";
import { Models } from "./Models";

const byProvider = (provider: string) =>
  models.roles.filter((role) => role.provider === provider);

test("each Codex card names a run from this page recorded on that model", () => {
  const codex = byProvider("codex");
  expect(codex.map((role) => role.name)).toEqual(["sol", "terra", "astra"]);
  for (const role of codex) {
    const run = role.evidence?.match(/\((site-[a-z0-9-]+)\)/)?.[1];
    expect(run, role.name).toBeDefined();
    expect(loadRun(run ?? "").model).toBe(role.model);
  }
});

test("every agy card is a model the recorded catalog lists under agy, with no evidence claim", () => {
  const agyModels = catalog.output
    .split("\n")
    .filter((line) => line.startsWith("agy "))
    .map((line) => line.split(/\s+/)[1]);
  const agy = byProvider("agy");
  expect(agy.length).toBeGreaterThan(0);
  for (const role of agy) {
    expect(agyModels, role.name).toContain(role.model);
    expect(role.evidence, role.name).toBeUndefined();
  }
});

test("server-renders Claude, then each provider with its models, the recorded catalog and the guidance", () => {
  document.body.innerHTML = renderToStaticMarkup(<Models catalog={catalog} />);
  const headings = (level: number) =>
    screen
      .getAllByRole("heading", { level })
      .map((heading) => heading.textContent);
  expect(headings(3)).toEqual([
    "Claude Code",
    ...models.providers.map((provider) => provider.name),
  ]);
  expect(headings(4)).toEqual(
    models.roles
      .filter((role) => role.provider !== "claude")
      .map((role) => role.name),
  );
  for (const role of models.roles) {
    expect(document.body.textContent).toContain(role.job.replaceAll("`", ""));
    if (role.evidence)
      expect(screen.getByText(role.evidence)).toBeInTheDocument();
  }
  expect(screen.getByLabelText(catalog.command).textContent).toBe(
    catalog.output,
  );
  expect(document.body.textContent).toContain("--model gemini-4-neon");
  expect(document.body.textContent).toContain(".codex/hooks.json");
  expect(document.body.textContent).toContain(".agents/hooks.json");
});

test("renders as a static component with no controls", () => {
  const { container } = render(<Models catalog={catalog} />);
  expect(container.querySelector("button, script")).toBeNull();
});
