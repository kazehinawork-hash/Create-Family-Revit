import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Looks for Revit.exe: explicit env var first, then the usual Autodesk installs. */
export function findRevitExe() {
  if (config.revit.exe && fs.existsSync(config.revit.exe)) return config.revit.exe;

  const roots = [
    "C:\\Program Files\\Autodesk",
    "C:\\Program Files (x86)\\Autodesk",
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    const direct = path.join(root, `Revit ${config.revit.version}`, "Revit.exe");
    if (fs.existsSync(direct)) return direct;

    const candidates = fs
      .readdirSync(root)
      .filter((name) => /^Revit \d{4}$/i.test(name))
      .sort()
      .reverse();

    for (const folder of candidates) {
      const exe = path.join(root, folder, "Revit.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }

  return "";
}

export async function bridgeAlive() {
  try {
    const response = await fetch(`${config.bridge.url}/health`, {
      headers: config.bridge.token ? { "X-Family-Token": config.bridge.token } : undefined,
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function revitRunning() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq Revit.exe", "/NH"], (error, stdout) => {
      resolve(!error && /revit\.exe/i.test(stdout ?? ""));
    });
  });
}

/**
 * Makes sure the Revit add-in bridge answers. Opens Revit when it is not running,
 * then waits for the add-in to load and start listening.
 */
export async function ensureBridge({ onStatus } = {}) {
  if (await bridgeAlive()) return { ok: true, started: false };

  const running = await revitRunning();
  onStatus?.(running ? "Waiting for the Revit add-in" : "Starting Revit");

  if (!running) {
    if (!config.revit.autoStart) {
      return {
        ok: false,
        error:
          "Revit is not running. Open Revit, wait for the Family Agent tab, then press Build again.",
      };
    }

    const exe = findRevitExe();
    if (!exe) {
      return {
        ok: false,
        error:
          "Revit could not be found on this machine. Set REVIT_EXE to Revit.exe in .env, or open Revit manually.",
      };
    }

    try {
      const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      console.log(`[revit] launched ${exe}`);
    } catch (error) {
      return { ok: false, error: `Could not start Revit: ${error.message}` };
    }
  }

  const deadline = Date.now() + config.revit.startTimeoutMs;
  let waited = 0;

  while (Date.now() < deadline) {
    if (await bridgeAlive()) {
      console.log(`[revit] bridge ready after ${Math.round(waited / 1000)}s`);
      return { ok: true, started: !running };
    }
    await sleep(2000);
    waited += 2000;
  }

  return {
    ok: false,
    error: running
      ? "Revit is open but the Family Agent bridge did not answer. Open the Family Agent tab and press “Studio bridge”."
      : "Revit did not finish starting in time. Open it manually, then press Build again.",
  };
}
