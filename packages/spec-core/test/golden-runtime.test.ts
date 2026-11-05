import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeSpec } from "../src/analyze.js";

/**
 * Recorded from the RFA runtime report for the same spec. saved-models/ is local
 * studio output, so the spec is committed here to keep this parity check in CI.
 */
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/ahu-chilled-water.golden.json", import.meta.url), "utf8"),
);

describe("golden localhost geometry", () => {
  it("matches the recorded RFA runtime report", () => {
    const analysis = analyzeSpec(fixture);

    expect(analysis.errors).toEqual([]);
    expect(analysis.ok).toBe(true);
    expect(analysis.model.parts).toHaveLength(30);
    expect(analysis.model.instances).toBe(36);

    const size = analysis.model.bounds?.size;
    expect(size).toBeTruthy();
    expect(Math.round(size!.x)).toBe(2778);
    expect(Math.round(size!.y)).toBe(1459);
    expect(Math.round(size!.z)).toBe(1089);
  });
});
