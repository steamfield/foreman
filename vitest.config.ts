import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/helpers/setup.ts"],
    // The monitor renders local wall-clock times; snapshots need one zone.
    env: { TZ: "UTC" },
    testTimeout: 30_000,
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/bin.ts"] },
  },
});
