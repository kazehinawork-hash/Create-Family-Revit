import fs from "node:fs";
import path from "node:path";

/**
 * Security helpers for the local studio API. They are deliberately small and pure so
 * they can be unit tested without starting Express.
 */

/** True when `target` resolves to `root` or a path inside it (no `..` escape). */
export function isInside(root, target) {
  const base = path.resolve(root);
  const candidate = path.resolve(String(target));
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The studio is a localhost tool: reject requests whose Host header names another
 * machine. That blocks DNS-rebinding pages from reaching the API. `extra` keeps
 * explicitly configured hosts working when someone opts into LAN access.
 */
export function isAllowedHost(header, extra = []) {
  if (!header) return false;
  let host = String(header).trim().toLowerCase();

  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    host = host.slice(1, end);
  } else {
    host = host.split(":")[0];
  }

  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return extra.some((value) => String(value).trim().toLowerCase() === host);
}

/** Extensions the studio accepts and is allowed to serve back. */
export const SAFE_UPLOAD_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".txt",
  ".csv",
  ".tsv",
  ".md",
  ".json",
  ".docx",
  ".xlsx",
]);

/** Types that may be rendered inline; everything else is forced to download. */
export const INLINE_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

export function isSafeUpload(name) {
  return SAFE_UPLOAD_EXTENSIONS.has(path.extname(String(name)).toLowerCase());
}

/**
 * Resolves a user supplied path only when it stays inside one of `roots` and points
 * at a real file. Returns null instead of throwing so routes can answer 403/404.
 */
export function safeDownloadPath(file, roots) {
  try {
    const resolved = path.resolve(String(file));
    if (!roots.some((root) => isInside(root, resolved))) return null;
    if (!fs.statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * State-changing requests from a browser must come from the studio origin. Requests
 * without an Origin header (curl, the Revit bridge, scripts) are allowed: the Host
 * check above already rejects foreign hostnames.
 */
export function isAllowedOrigin(origin, hostHeader, extra = []) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (isAllowedHost(url.host, extra)) return true;
    return Boolean(hostHeader) && url.host.toLowerCase() === String(hostHeader).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Small in-process sliding-window limiter. The studio is a single-user tool, so an
 * external dependency is not worth it; this stops a runaway tab from spawning dozens
 * of CLI agent runs.
 */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return { allowed: true, retryAfter: 0 };
    }

    entry.count += 1;
    if (entry.count <= max) return { allowed: true, retryAfter: 0 };

    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)),
    };
  };
}

const BLOCKED_OUTBOUND_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
]);

/**
 * Guard for the "verify API key" endpoint. Only http(s) is allowed and the cloud
 * metadata addresses are refused; localhost stays available for Ollama/LM Studio.
 */
export function checkOutboundUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http(s) endpoints are supported" };
  }

  if (BLOCKED_OUTBOUND_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: "That endpoint is not allowed" };
  }

  return { ok: true, url };
}
