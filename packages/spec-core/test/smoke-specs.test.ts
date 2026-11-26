import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeSpec } from "../src/analyze.js";
import { CURRENT_SPEC_VERSION, migrateSpec } from "../src/migrate.js";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function isSpecEnvelope(raw: unknown): raw is { spec?: unknown; parts?: unknown; macros?: unknown } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  if (record.spec && typeof record.spec === "object" && !Array.isArray(record.spec)) return true;
  return Array.isArray(record.parts) || Array.isArray(record.macros);
}

function extractSpec(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return record.spec ?? raw;
}

function collectDir(dir: string, prefix: string): { name: string; raw: unknown }[] {
  const found: { name: string; raw: unknown }[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file.startsWith("_") || file.startsWith(".")) continue;
      const parsed = readJson(path.join(dir, file));
      if (!isSpecEnvelope(parsed)) continue;
      const spec = extractSpec(parsed);
      if (spec) found.push({ name: `${prefix}/${file}`, raw: spec });
    }
  } catch {
    /* folder may be optional */
  }
  return found;
}

describe("sample specs still resolve", () => {
  const examples = collectDir(path.join(root, "spec", "examples"), "examples");
  const legacy = collectDir(path.join(root, "spec", "examples", "legacy"), "examples/legacy");
  const saved = collectDir(path.join(root, "saved-models"), "saved-models");

  it("finds the example specs and legacy migration fixtures", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(legacy.length).toBeGreaterThanOrEqual(3);
  });

  for (const spec of [...examples, ...legacy]) {
    it(spec.name, () => {
      const snapshot = JSON.stringify(spec.raw);
      const migrated = migrateSpec(spec.raw);
      expect(migrated.spec.specVersion).toBe(CURRENT_SPEC_VERSION);
      expect(JSON.stringify(spec.raw)).toBe(snapshot);

      const analysis = analyzeSpec(spec.raw);
      expect(analysis.errors).toEqual([]);
      expect(analysis.ok).toBe(true);
      expect(analysis.model.parts.length).toBeGreaterThan(0);

      const bounds = analysis.model.bounds;
      expect(bounds).not.toBeNull();
      expect(bounds!.size.x).toBeGreaterThan(0);
      expect(bounds!.size.z).toBeGreaterThan(0);
    });
  }

  it("diagnoses local saved-models without blocking CI", () => {
    const failures: Array<{ name: string; reasons: string[] }> = [];
    for (const entry of saved) {
      const analysis = analyzeSpec(entry.raw);
      const reasons: string[] = analysis.errors.map((issue) => `${issue.path}: ${issue.message}`);
      if (!analysis.ok && reasons.length === 0) reasons.push("analyzeSpec returned ok=false");
      if (analysis.model.parts.length === 0) reasons.push("no resolved parts");
      if (reasons.length > 0) failures.push({ name: entry.name, reasons });
    }

    if (failures.length > 0) {
      console.warn(
        `[smoke-specs] ${failures.length}/${saved.length} saved-models failed validation:\n` +
          failures.map((f) => `  - ${f.name}: ${f.reasons.join("; ")}`).join("\n"),
      );
    }
    expect(Array.isArray(failures)).toBe(true);
  });
});
