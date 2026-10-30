import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeSpec } from "../src/analyze.js";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function collect(): { name: string; raw: unknown }[] {
  const found: { name: string; raw: unknown }[] = [];

  const examples = path.join(root, "spec", "examples");
  for (const file of readdirSync(examples).filter((entry) => entry.endsWith(".json"))) {
    found.push({ name: `examples/${file}`, raw: readJson(path.join(examples, file)) });
  }

  const saved = path.join(root, "saved-models");
  try {
    for (const file of readdirSync(saved).filter((entry) => entry.endsWith(".json"))) {
      const raw = readJson(path.join(saved, file)) as { spec?: unknown };
      found.push({ name: `saved-models/${file}`, raw: raw?.spec ?? raw });
    }
  } catch {
    /* the folder is optional */
  }

  return found;
}

describe("sample specs still resolve", () => {
  const specs = collect();

  it("finds the example specs", () => {
    // saved-models/ is local studio output and is not tracked, so CI only has the
    // two hand-written examples in spec/examples.
    expect(specs.length).toBeGreaterThanOrEqual(2);
  });

  for (const spec of specs) {
    it(spec.name, () => {
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
});
