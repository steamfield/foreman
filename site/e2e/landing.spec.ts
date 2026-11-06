import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import supervisor from "../fixtures/runs/fix-supervisor.json" with { type: "json" };
import start from "../fixtures/cli/start-wait.json" with { type: "json" };
import wait from "../fixtures/cli/wait-all.json" with { type: "json" };
import answer from "../fixtures/cli/answer.json" with { type: "json" };
import status from "../fixtures/cli/status-release.json" with { type: "json" };
import result from "../fixtures/cli/result.json" with { type: "json" };
import archive from "../fixtures/cli/archive.json" with { type: "json" };
import doctor from "../fixtures/cli/doctor.json" with { type: "json" };
import { hero, install } from "../src/data/landing";
import { site } from "../src/config";

const ids = [
  "why",
  "session",
  "lifecycle",
  "handoff",
  "questions",
  "parallel",
  "commands",
  "guardrails",
  "agents",
  "install",
];
const q1 = supervisor.questions.find(
  (question) => question._tag === "Asked" && question.id === "q1",
);
if (!q1 || typeof q1.question !== "string")
  throw new Error("Missing recorded q1 question");
const questionText = q1.question;
const npm = install.options.find((option) => option.id === "npm");
if (!npm) throw new Error("Missing npm install option");

for (const path of ["/", "/missing-page"]) {
  test(`${path} passes accessibility checks`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(path === "/" ? 200 : 404);
    if (path !== "/")
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Page not found",
      );
    await expect(
      page.getByRole("region", { name: "Analytics consent" }),
    ).toHaveCount(0);
    // Reveal lazy islands before checking their final reduced-motion states.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
        scrollTo(0, y);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
    });
    if (path === "/") {
      await expect(page.locator('#lifecycle [role="tablist"]')).toBeVisible();
      await expect(page.locator('#commands [role="tablist"]')).toBeVisible();
    }
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    const details = await Promise.all(
      violations.flatMap((violation) =>
        violation.nodes.map(async (node) => ({
          rule: violation.id,
          target: node.target,
          html: node.html,
          section: await page
            .locator(node.target.join(" "))
            .first()
            .evaluate(
              (element) => element.closest("section")?.id || "outside sections",
            ),
        })),
      ),
    );
    expect(violations, JSON.stringify(details, null, 2)).toEqual([]);
  });
}

test("sections and header destinations exist", async ({ page }) => {
  await page.goto("/");
  for (const id of ids) {
    await expect(
      page.locator(`section#${id} h2`),
      `section #${id}`,
    ).toBeVisible();
  }
  const hrefs = await page
    .locator("header nav a")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs).toEqual([...site.nav.map((item) => item.href), "/#install"]);
  for (const href of hrefs) {
    expect(href).toBeTruthy();
    const url = new URL(href || "", page.url());
    if (url.origin === new URL(page.url()).origin && url.pathname !== "/") {
      expect(
        (await page.request.get(url.href)).ok(),
        `header link ${href}`,
      ).toBe(true);
    }
    if (url.pathname === "/" && url.hash) {
      await expect(
        page.locator(`[id="${url.hash.slice(1)}"]`),
        `header link ${href}`,
      ).toHaveCount(1);
    }
  }
});

test("phone has no horizontal page overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Phone viewport only");
  await page.goto("/");
  for (const id of ids) await page.locator(`#${id}`).scrollIntoViewIfNeeded();
  await expect(page.locator('#lifecycle [role="tablist"]')).toBeVisible();
  await expect(page.locator('#commands [role="tablist"]')).toBeVisible();
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return {
      viewport: width,
      scroll: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll("body *")]
        .map((element) => ({
          element: element.tagName.toLowerCase(),
          id: element.id,
          section: element.closest("section")?.id || "outside sections",
          right: Math.round(element.getBoundingClientRect().right),
          width: Math.round(element.getBoundingClientRect().width),
        }))
        .filter((element) => element.right > width)
        .sort((a, b) => b.right - a.right)
        .slice(0, 15),
    };
  });
  expect(overflow.scroll, JSON.stringify(overflow, null, 2)).toBe(
    overflow.viewport,
  );
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("renders the hero and transcript", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      hero.title,
    );
    await expect(page.locator("[data-hero]")).toContainText(npm.command);
    await expect(
      page
        .locator("[data-hero]")
        .getByRole("region", { name: "Claude conversation" })
        .getByText(questionText),
    ).toBeVisible();
  });

  test("renders every recorded command output and lifecycle list", async ({
    page,
  }) => {
    await page.goto("/");
    for (const { name, recording } of [
      { name: "start-wait", recording: start },
      { name: "wait-all", recording: wait },
      { name: "answer", recording: answer },
      { name: "status-release", recording: status },
      { name: "result", recording: result },
      { name: "archive", recording: archive },
      { name: "doctor", recording: doctor },
    ]) {
      const panel = page.locator(`#command-${name}`);
      await expect(panel).toBeVisible();
      await expect(panel.locator("pre")).toBeVisible();
      await expect(panel.locator("pre")).toContainText(recording.output);
    }
    const lifecycle = page.locator('#lifecycle ol[aria-label="Run lifecycle"]');
    await expect(lifecycle).toBeVisible();
    const source = readFileSync(
      new URL("../src/data/lifecycle.ts", import.meta.url),
      "utf8",
    );
    const nodes = source.split("nodes: [")[1]?.split("edges: [")[0] ?? "";
    const labels = [...nodes.matchAll(/label: "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(labels).toContain("Claude decides");
    await expect(lifecycle.locator("li")).toHaveCount(labels.length);
    for (let i = 0; i < labels.length; i++) {
      await expect(lifecycle.locator("li").nth(i)).toContainText(
        labels[i] ?? "",
      );
    }
  });
});

async function expectFocusRing(locator: Locator) {
  const ring = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
      offset: style.outlineOffset,
    };
  });
  expect(
    ring,
    `Focus ring on ${await locator.evaluate((element) => element.outerHTML)}`,
  ).toMatchObject({ style: "solid", width: "2px", offset: "2px" });
  expect(ring.color).not.toBe("rgba(0, 0, 0, 0)");
}

test("keyboard reaches the skip link, header and main controls with visible focus", async ({
  page,
}) => {
  await page.goto("/");
  for (const id of ids) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
  }
  await expect(page.locator('#lifecycle [role="tablist"]')).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await expectFocusRing(page.locator(":focus"));
  const headerLinks = page.locator("header a:visible");
  for (const link of await headerLinks.all()) {
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await expectFocusRing(link);
  }
  // Traverse the actual tab sequence, marking each control as focus reaches it. Lazy
  // islands render controls as they enter view (the hero's "Show all" toggles appear
  // only after it measures its lines), so marks are applied on focus, not up front.
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press("Tab");
    const inMain = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || !el.closest("main")) return false;
      el.setAttribute("data-e2e-reached", "");
      return true;
    });
    if (!inMain) break;
    await expectFocusRing(page.locator(":focus"));
  }
  const missing = await page
    .locator("main a[href], main button")
    .evaluateAll((elements) =>
      elements
        .filter(
          (el) =>
            el instanceof HTMLElement &&
            el.getClientRects().length > 0 &&
            (!el.closest('[role="tablist"]') ||
              el.getAttribute("aria-selected") === "true") &&
            !el.hasAttribute("disabled") &&
            !el.hasAttribute("data-e2e-reached"),
        )
        .map(
          (el) =>
            `${el.closest("section")?.id || "hero"}: ${el.getAttribute("aria-label") ?? el.textContent?.trim()}`,
        ),
    );
  expect(missing, "Main controls missing from tab order").toEqual([]);
  for (const list of await page.locator('main [role="tablist"]').all()) {
    const tabs = list.getByRole("tab");
    const count = await tabs.count();
    const selected = list.locator('[role="tab"][aria-selected="true"]');
    await selected.focus();
    const visited = new Set<string>();
    const key =
      (await list.getAttribute("aria-orientation")) === "vertical"
        ? "ArrowDown"
        : "ArrowRight";
    for (let i = 0; i < count; i++) {
      const active = page.locator(":focus");
      visited.add((await active.getAttribute("id")) ?? "");
      await expectFocusRing(active);
      await page.keyboard.press(key);
    }
    expect(
      visited.size,
      `Keyboard access to ${await list.getAttribute("aria-label")}`,
    ).toBe(count);
  }
});

test("hero copy button copies the npm command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(npm.command);
});
