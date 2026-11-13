import { createHash } from "node:crypto";

const MAX_ENTRIES = 40;
const TTL_MS = 30 * 60 * 1000;
const entries = new Map();

export function cacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readCachedResult(key) {
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    entries.delete(key);
    return null;
  }

  // Refresh LRU position.
  entries.delete(key);
  entries.set(key, entry);
  return entry.value;
}

export function writeCachedResult(key, value) {
  entries.delete(key);
  entries.set(key, { at: Date.now(), value });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Test hook: cached results must not leak between cases. */
export function clearCachedResults() {
  entries.clear();
}
