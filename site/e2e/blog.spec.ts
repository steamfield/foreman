import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const destination of ["index", "article"]) {
  test(`blog ${destination} is accessible and fits the viewport`, async ({
    page,
  }) => {
    await page.goto("/blog");
    if (destination === "article") {
      const first = page.locator("main h2 a").first();
      const href = (await first.count())
        ? await first.getAttribute("href")
        : null;
      test.skip(!href, "No published articles");
      if (!href) return;
      await page.goto(href);
      await expect(
        page.locator('[aria-label="Breadcrumb"] [aria-current="page"]'),
      ).toHaveCount(1);
      const toc = page.locator("details > summary", {
        hasText: /^On this page$/,
      });
      if (await toc.isVisible()) await toc.click();
      await page
        .locator('[aria-label="Install foreman"]')
        .scrollIntoViewIfNeeded();
      await expect(
        page.locator('[aria-label="Install foreman"] [role="tablist"]'),
      ).toBeVisible();
    }
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      header: document.querySelector("body > header")?.getBoundingClientRect()
        .right,
    }));
    expect(overflow.scroll).toBe(overflow.viewport);
    expect(overflow.header).toBeLessThanOrEqual(overflow.viewport);
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations).toEqual([]);
  });
}
