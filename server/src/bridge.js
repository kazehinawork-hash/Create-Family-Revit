import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { writeJsonAtomic } from "./files.js";

export function slugify(name) {
  return (
    String(name || "family")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/^-+|-+$/g, "") || "family"
  );
}

const knownBuildOutputRoots = new Set();

/**
 * The add-in writes to Environment.SpecialFolder.MyDocuments, which OneDrive often
 * redirects outside the server's default ~/Documents. Remember the exact folder a
 * build wrote to so /api/download-rfa can serve the file the studio just produced.
 */
export function rememberBuildOutput(filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) return;
  knownBuildOutputRoots.add(path.dirname(path.resolve(filePath)));
}

export function getBuildOutputRoots() {
  return [...knownBuildOutputRoots];
}

export function queueFile(spec) {
  fs.mkdirSync(config.dirs.queue, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(config.dirs.queue, `${stamp}-${slugify(spec.name)}.json`);
  writeJsonAtomic(file, spec);
  return file;
}

function queuedResponse(spec, detail) {
  const file = queueFile(spec);
  return {
    ok: false,
    mode: "queue",
    file,
    message:
      "Revit is not connected, so the family was queued. Open Revit 2024 and press “Build pending” in the Family Agent tab.",
    detail,
  };
}

export async function buildMultiType(spec) {
  let response;
  try {
    response = await fetch(`${config.bridge.url}/build-multi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.bridge.token ? { "X-Family-Token": config.bridge.token } : {}),
      },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(config.bridge.timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: `Revit bridge unreachable: ${error.message}` };
  }

  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.ok !== false) rememberBuildOutput(payload.path);

  if (!response.ok || payload.ok === false) {
    return {
      ok: false,
      error: payload.error || `The Revit bridge returned ${response.status}`,
      warnings: payload.warnings || [],
    };
  }

  return { ok: true, path: payload.path, types: payload.types, warnings: payload.warnings || [] };
}

export async function buildFamily(spec) {
  const started = Date.now();

  let response;
  try {
    response = await fetch(`${config.bridge.url}/build`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.bridge.token ? { "X-Family-Token": config.bridge.token } : {}),
      },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(config.bridge.timeoutMs),
    });
  } catch (error) {
    return queuedResponse(spec, error.message);
  }

  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.ok !== false) rememberBuildOutput(payload.path);

  if (!response.ok || payload.ok === false) {
    if (response.status === 409) {
      return {
        ok: false,
        mode: "revit",
        busy: true,
        error: payload.error || "Revit is busy with another build",
      };
    }
    return {
      ok: false,
      mode: "revit",
      error: payload.error || `The Revit bridge returned ${response.status}`,
      warnings: payload.warnings || [],
    };
  }

  return {
    ok: true,
    mode: "revit",
    path: payload.path,
    revitVersion: payload.revitVersion,
    warnings: payload.warnings || [],
    stats: payload.stats,
    elapsedMs: Date.now() - started,
  };
}
