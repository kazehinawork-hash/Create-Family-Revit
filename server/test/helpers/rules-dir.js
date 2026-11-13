import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every test that can write overrides/learned packs must run against a temporary
 * rules directory, so the repository stays clean.
 */

export function rulesRoot() {
  return path.resolve(import.meta.dirname, "..", "..", "rules");
}

/** Files + mtimes of the real rules tree, to prove tests did not touch it. */
export function snapshotRulesTree() {
  const root = rulesRoot();
  const snapshot = {};

  const walk = (directory, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const key = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        walk(full, key);
      } else {
        snapshot[key] = fs.statSync(full).mtimeMs;
      }
    }
  };

  walk(root, "");
  return snapshot;
}

export async function withRulesDir(fn) {
  const previous = process.env.FAMILY_RULES_DIR;
  const root = rulesRoot();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "family-rules-"));

  for (const file of fs.readdirSync(root)) {
    if (!file.endsWith(".json")) continue;
    fs.copyFileSync(path.join(root, file), path.join(temp, file));
  }

  process.env.FAMILY_RULES_DIR = temp;
  try {
    return await fn(temp);
  } finally {
    if (previous === undefined) delete process.env.FAMILY_RULES_DIR;
    else process.env.FAMILY_RULES_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
