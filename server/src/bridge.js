import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { writeJsonAtomic } from "./files.js";

export function slugify(name) {
  return (
    String(name || "family")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "family"
  );
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
