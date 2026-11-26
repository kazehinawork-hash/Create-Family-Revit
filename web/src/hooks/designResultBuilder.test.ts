import type { FamilySpec } from "@family/spec-core";
import { describe, expect, it } from "vitest";
import type { DesignStats } from "../lib/api";
import { vi } from "../lib/strings";
import { buildDesignResultEntry, mergeSessionUsage } from "./designResultBuilder";

const formatDate = () => "10:15";

const makeSpec = (name: string, notes?: string[]): FamilySpec => ({
  schemaVersion: "1.0",
  name,
  category: "Generic Model",
  units: "mm",
  ...(notes ? { notes } : {}),
  parameters: [{ name: "Length", type: "Length", value: 600 }],
  parts: [
    {
      id: "body",
      name: "Body",
      material: "Steel",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Length]", y: 100, z: 50 } },
    },
  ],
  materials: [{ name: "Steel" }],
});

const baseStats = (overrides: Partial<DesignStats> = {}): DesignStats => ({
  parameters: 1,
  parts: 1,
  instances: 1,
  materials: 1,
  bounds: null,
  attempts: 1,
  elapsedMs: 1200,
  ...overrides,
});

describe("buildDesignResultEntry", () => {
  it("builds a clean diff summary, local metaInfo, and resolves notes on ok outcome", () => {
    const prev = makeSpec("Old", ["Initial frame"]);
    const next: FamilySpec = {
      ...makeSpec("New", ["Initial frame", "Updated length to 800mm"]),
      parameters: [{ name: "Length", type: "Length", value: 800 }],
    };

    const result = buildDesignResultEntry({
      specValue: next,
      stats: baseStats({
        fastEdit: { name: "Length", type: "Length", value: 800 },
        calls: [{ model: "local", promptChars: 10, outChars: 20 }],
      }),
      previousSpec: prev,
      hadSpec: true,
      t: vi,
      formatDate,
    });

    expect(result.resolvedOk).toBe(true);
    expect(result.incomplete).toBeNull();
    expect(result.entry.tone).toBe("normal");
    expect(result.entry.undoSpec).toBe(prev);
    expect(result.entry.metaInfo).toMatchObject({ local: true, inChars: 10, outChars: 20 });
    expect(result.entry.check?.ok).toBe(true);
  });

  it("reports incomplete status and fresh rerun action for cached results", () => {
    const result = buildDesignResultEntry({
      specValue: makeSpec("Partial"),
      stats: baseStats({
        cached: true,
        cachedAt: 1700000000000,
        complete: false,
        missing: ["Mounting bracket"],
        warnings: ["Thin wall"],
        model: "gemini-4",
      }),
      previousSpec: null,
      hadSpec: false,
      outcome: "incomplete",
      t: vi,
      formatDate,
    });

    expect(result.incomplete).toEqual(["Mounting bracket"]);
    expect(result.entry.action).toMatchObject({ kind: "fresh" });
    expect(result.entry.metaInfo?.cached).toContain("10:15");
    expect(result.entry.warnings).toEqual(["Thin wall"]);
  });

  it("accumulates model call counts into sessionUsage", () => {
    const first = mergeSessionUsage({}, baseStats({ calls: [{ model: "m1", modelCalls: 2 }] }));
    const second = mergeSessionUsage(first, baseStats({ calls: [{ model: "m1", modelCalls: 1 }] }));
    expect(second).toEqual({ m1: 3 });
  });
});
