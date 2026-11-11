import { describe, expect, it } from "vitest";
import { analyzeSpec } from "../src/analyze.js";
import type { FamilySpec, FamilyPart } from "../src/types.js";

function spec(part: FamilyPart): FamilySpec {
  return {
    schemaVersion: "1.0",
    name: "Tube",
    category: "Pipe Fitting",
    units: "mm",
    parameters: [],
    materials: [],
    parts: [part],
  };
}

const branch: FamilyPart = {
  id: "branch",
  name: "Inclined Branch",
  solid: {
    kind: "tube",
    start: { x: 0, y: 0, z: 0 },
    end: { x: 100, y: 0, z: 100 },
    radius: 20,
    segments: 24,
  },
};

describe("tube primitive", () => {
  it("resolves an arbitrary-axis tube and its exact envelope", () => {
    const analysis = analyzeSpec(spec(branch));
    expect(analysis.ok).toBe(true);

    const solid = analysis.model.parts[0].solid;
    expect(solid.kind).toBe("tube");
    if (solid.kind !== "tube") return;

    expect(solid.length).toBeCloseTo(Math.hypot(100, 100), 6);
    expect(solid.direction.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(solid.direction.z).toBeCloseTo(Math.SQRT1_2, 6);

    const bounds = analysis.model.bounds!;
    const extent = 20 * Math.SQRT1_2;
    expect(bounds.min.x).toBeCloseTo(-extent, 6);
    expect(bounds.max.x).toBeCloseTo(100 + extent, 6);
    expect(bounds.min.y).toBeCloseTo(-20, 6);
    expect(bounds.max.y).toBeCloseTo(20, 6);
    expect(bounds.min.z).toBeCloseTo(-extent, 6);
    expect(bounds.max.z).toBeCloseTo(100 + extent, 6);
  });

  it("marks a solid tube as a native sweep", () => {
    const analysis = analyzeSpec(spec(branch));
    expect(analysis.partParity[0].status).toBe("sweep");
    expect(analysis.partParity[0].native).toBe(true);
    expect(analysis.parity.some((risk) => risk.code === "tube.hollow")).toBe(false);
  });

  it("warns that a hollow tube may fall back to FreeFormElement", () => {
    const analysis = analyzeSpec(
      spec({
        ...branch,
        solid: { ...branch.solid, innerRadius: 12 } as FamilyPart["solid"],
      }),
    );
    expect(analysis.partParity[0].status).toBe("sweep");
    expect(analysis.parity.some((risk) => risk.code === "tube.hollow")).toBe(true);
  });

  it("rejects a tube with identical endpoints", () => {
    const analysis = analyzeSpec(
      spec({
        ...branch,
        solid: {
          ...branch.solid,
          end: { x: 0, y: 0, z: 0 },
        } as FamilyPart["solid"],
      }),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.errors.some((issue) => issue.message.includes("must differ"))).toBe(true);
  });
});
