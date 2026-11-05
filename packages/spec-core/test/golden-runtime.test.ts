import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeSpec } from "../src/analyze.js";

/**
 * Golden specs and their expected resolved geometry. The first three match the
 * recorded RFA runtime reports; saved-models/ is local output, so the specs are
 * committed here to keep the parity checks in CI.
 */
const cases = [
  {
    file: "ahu-chilled-water.golden.json",
    parts: 30,
    instances: 36,
    connectors: 5,
    bounds: [2778, 1459, 1089],
  },
  {
    file: "portable-cooler.golden.json",
    parts: 16,
    instances: 37,
    connectors: 3,
    bounds: [503, 423, 1050],
  },
  {
    file: "wet-alarm-valve.golden.json",
    parts: 36,
    instances: 43,
    connectors: 2,
    bounds: [335, 254, 684],
  },
  {
    file: "plant-rack.golden.json",
    parts: 58,
    instances: 372,
    connectors: 0,
    bounds: [1006, 511, 1500],
  },
] as const;

describe("golden localhost geometry", () => {
  for (const expected of cases) {
    it(`matches ${expected.file}`, () => {
      const fixture = JSON.parse(
        readFileSync(new URL(`./fixtures/${expected.file}`, import.meta.url), "utf8"),
      );
      const analysis = analyzeSpec(fixture);

      expect(analysis.errors).toEqual([]);
      expect(analysis.ok).toBe(true);
      expect(analysis.model.parts).toHaveLength(expected.parts);
      expect(analysis.model.instances).toBe(expected.instances);
      expect(analysis.model.connectors).toHaveLength(expected.connectors);

      const size = analysis.model.bounds?.size;
      expect(size).toBeTruthy();
      expect([
        Math.round(size!.x),
        Math.round(size!.y),
        Math.round(size!.z),
      ]).toEqual(expected.bounds);
    });
  }
});
