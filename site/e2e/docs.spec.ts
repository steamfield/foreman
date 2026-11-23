import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { guideId } from "../src/lib/guide";

const PAGE = "/docs/providers";

/** The page fits its viewport: no horizontal scroll and the header stays inside it. */
async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    header: document.querySelector("body > header")?.getBoundingClientRect()
      .right,
  }));
  expect(overflow.scroll).toBe(overflow.viewport);
  expect(overflow.header).toBeLessThanOrEqual(overflow.viewport);
}

/** The sidebar on desktop, or the opened Docs menu on a phone. */
async function docsNav(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Docs", exact: true });
  if (await sidebar.isVisible()) return sidebar;
  await page.getByText("Docs menu", { exact: true }).click();
  const menu = page.getByRole("navigation", { name: "Docs menu" });
  await expect(menu).toBeVisible();
  return menu;
}

// Every guide page, so content (an empty table header, a wide code block) is checked too.
const guidePages = readdirSync("../docs/guide")
  .filter((file) => file.endsWith(".md"))
  .map((file) => `/docs/${guideId(file)}`);

for (const path of ["/docs", ...guidePages]) {
  test(`${path} is accessible and fits the viewport`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expectNoOverflow(page);
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]);
  });
}

test("the docs nav marks the current page and its outline jumps to a section", async ({
  page,
}) => {
  await page.goto(PAGE);
  const nav = await docsNav(page);
  const current = nav.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", PAGE);
  const section = nav.locator("[data-toc] a").first();
  const hash = await section.getAttribute("href");
  expect(hash).toMatch(/^#.+/);
  await section.click();
  await expect(page).toHaveURL(new RegExp(`${hash}$`));
  await expect(page.locator(`[id="${hash?.slice(1)}"]`)).toBeInViewport();
  await expectNoOverflow(page);
});

test("the docs home links every page and the pager moves between pages", async ({
  page,
}) => {
  await page.goto("/docs");
  const cards = page.locator(".docs-card a");
  expect(await cards.count()).toBeGreaterThan(1);
  await cards.first().click();
  await expect(page).toHaveURL(/\/docs\/[\w-]+$/);
  const next = page.getByRole("navigation", { name: "Pagination" });
  const nextLink = next.locator('a[rel="next"]');
  const target = await nextLink.getAttribute("href");
  await nextLink.click();
  await expect(page).toHaveURL(new RegExp(`${target}$`));
  await expect(next.locator('a[rel="prev"]')).toBeVisible();
});
