import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    // Locally the machine already has Chrome; CI installs Chromium instead.
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
