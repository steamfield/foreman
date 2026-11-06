import { defineConfig } from "@playwright/test";

const port = Number(process.env.PORT_E2E ?? 4322);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, reducedMotion: "reduce", trace: "retain-on-failure" },
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "phone",
      use: { browserName: "chromium", viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: `make preview PORT_WEB=${port}`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
