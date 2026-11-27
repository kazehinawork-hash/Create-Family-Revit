import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

function allocateFreePorts(count: number): number[] {
  const script = `
    const net = require("node:net");
    const servers = [];
    Promise.all(
      Array.from({ length: ${count} }, () => new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address();
          servers.push(srv);
          resolve(addr.port);
        });
      }))
    ).then((ports) => {
      for (const srv of servers) srv.close();
      process.stdout.write(JSON.stringify(ports));
    });
  `;
  const raw = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  return JSON.parse(raw) as number[];
}

if (!process.env.E2E_DATA_DIR) {
  process.env.E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "family-agent-e2e-"));
}
if (!process.env.E2E_WEB_PORT || !process.env.E2E_API_PORT) {
  const [webPort, apiPort] = allocateFreePorts(2);
  process.env.E2E_WEB_PORT = String(webPort);
  process.env.E2E_API_PORT = String(apiPort);
}

const e2eDataDir = process.env.E2E_DATA_DIR;
const e2eWebPort = process.env.E2E_WEB_PORT;
const e2eApiPort = process.env.E2E_API_PORT;
const baseURL = `http://127.0.0.1:${e2eWebPort}`;

export default defineConfig({
  testDir: "./web/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  globalTeardown: "./web/e2e/global-teardown.ts",
  use: {
    baseURL,
    // Locally the machine already has Chrome; CI installs Chromium instead.
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      E2E_DATA_DIR: e2eDataDir,
      E2E_WEB_PORT: e2eWebPort,
      E2E_API_PORT: e2eApiPort,
    },
  },
});
