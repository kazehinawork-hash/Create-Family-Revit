import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.E2E_DATA_DIR;
const webPort = process.env.E2E_WEB_PORT;
const apiPort = process.env.E2E_API_PORT;

if (!dataDir || !webPort || !apiPort) {
  throw new Error("E2E_DATA_DIR, E2E_WEB_PORT, and E2E_API_PORT must be set before launching scripts/e2e-server.mjs");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const coreDist = path.join(root, "packages", "spec-core", "dist", "index.js");
if (!fs.existsSync(coreDist)) {
  execFileSync(npm, ["run", "build:core"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const dirs = {
  saved: path.join(dataDir, "saved-models"),
  jobs: path.join(dataDir, "jobs"),
  uploads: path.join(dataDir, "uploads"),
  out: path.join(dataDir, "out"),
  queue: path.join(dataDir, "queue"),
  rules: path.join(dataDir, "rules"),
  viteCache: path.join(dataDir, "vite-cache"),
};

for (const dir of Object.values(dirs)) {
  fs.mkdirSync(dir, { recursive: true });
}

const builtinRulesDir = path.join(root, "server", "rules");
if (fs.existsSync(builtinRulesDir)) {
  fs.cpSync(builtinRulesDir, dirs.rules, { recursive: true, force: true });
}

const children = [];
let shuttingDown = false;

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stopChild(child);
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForApi(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* API still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Isolated E2E API did not become ready at ${url} within ${timeoutMs}ms`);
}

const api = spawn(process.execPath, [path.join(root, "server", "src", "index.js")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    REVIT_AUTO_START: "0",
    FAMILY_SAVED_DIR: dirs.saved,
    FAMILY_JOBS_DIR: dirs.jobs,
    FAMILY_UPLOADS_DIR: dirs.uploads,
    FAMILY_OUT_DIR: dirs.out,
    FAMILY_QUEUE_DIR: dirs.queue,
    FAMILY_RULES_DIR: dirs.rules,
  },
});
children.push(api);
api.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[e2e-server] api exited early with code ${code}`);
    shutdown(code ?? 1);
  }
});

await waitForApi(`http://127.0.0.1:${apiPort}/api/ping`);

const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const web = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
  cwd: path.join(root, "web"),
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "development",
    VITE_HOST: "127.0.0.1",
    VITE_PORT: String(webPort),
    VITE_API_TARGET: `http://127.0.0.1:${apiPort}`,
    VITE_CACHE_DIR: dirs.viteCache,
  },
});
children.push(web);
web.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[e2e-server] web exited early with code ${code}`);
    shutdown(code ?? 1);
  }
});
