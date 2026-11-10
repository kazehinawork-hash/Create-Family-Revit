import { describe, expect, it } from "vitest";
import { analyzeSpec } from "../src/analyze.js";
import type { FamilySpec, FamilyPart } from "../src/types.js";

function spec(parts: FamilyPart[]): FamilySpec {
  return {
    schemaVersion: "1.0",
    name: "Parity",
    category: "Generic Model",
    units: "mm",
    parameters: [],
    materials: [],
    parts,
  };
}

const base = (solid: FamilyPart["solid"], extra: Partial<FamilyPart> = {}): FamilyPart => ({
  id: "part",
  name: "Part",
  solid,
  ...extra,
});

describe("build parity", () => {
  it("flags a loft with more than two sections", () => {
    const analysis = analyzeSpec(
      spec([
        base({
          kind: "loft",
          axis: "z",
          segments: 16,
          sections: [
            { at: 0, profile: { kind: "circle", radius: 50 } },
            { at: 100, profile: { kind: "circle", radius: 70 } },
            { at: 200, profile: { kind: "circle", radius: 50 } },
          ],
        }),
      ]),
    );

    expect(analysis.ok).toBe(true);
    expect(analysis.partParity[0].status).toBe("freeform");
    expect(analysis.partParity[0].native).toBe(false);
    expect(analysis.parity.some((risk) => risk.code === "loft.multi-section")).toBe(true);
  });

  it("flags an X-axis loft as a FreeForm fallback", () => {
    const analysis = analyzeSpec(
      spec([
        base({
          kind: "loft",
          axis: "x",
          segments: 16,
          sections: [
            { at: 0, profile: { kind: "circle", radius: 50 } },
            { at: 100, profile: { kind: "circle", radius: 70 } },
          ],
        }),
      ]),
    );

    expect(analysis.partParity[0].status).toBe("freeform");
    expect(analysis.partParity[0].native).toBe(false);
    expect(analysis.parity.some((risk) => risk.code === "loft.axis")).toBe(true);
  });

  it("marks frustums on Z and X as native revolutions with baked radii", () => {
    const native = analyzeSpec(
      spec([
        base({
          kind: "frustum",
          axis: "z",
          base: { x: 0, y: 0, z: 0 },
          radiusBottom: 50,
          radiusTop: 70,
          height: 100,
        }),
      ]),
    );
    expect(native.partParity[0].status).toBe("native-revolve");
    expect(native.parity.some((risk) => risk.code === "frustum.baked-radius")).toBe(true);

    const alongX = analyzeSpec(
      spec([
        base({
          kind: "frustum",
          axis: "x",
          base: { x: 0, y: 0, z: 0 },
          radiusBottom: 50,
          radiusTop: 70,
          height: 100,
        }),
      ]),
    );
    expect(alongX.partParity[0].status).toBe("native-revolve");
    expect(alongX.partParity[0].native).toBe(true);
    expect(alongX.parity.some((risk) => risk.code === "frustum.baked-radius")).toBe(true);
  });

  it("keeps a cylinder with parallel bolt cuts as a native multi-hole extrusion", () => {
    const analysis = analyzeSpec(
      spec([
        base(
          {
            kind: "cylinder",
            axis: "z",
            base: { x: 0, y: 0, z: 0 },
            radius: 100,
            height: 20,
          },
          {
            cuts: [
              {
                kind: "cylinder",
                axis: "z",
                base: { x: 40, y: 0, z: 0 },
                radius: 8,
                height: 20,
              },
              {
                kind: "cylinder",
                axis: "z",
                base: { x: -40, y: 0, z: 0 },
                radius: 8,
                height: 20,
              },
            ],
          },
        ),
      ]),
    );

    expect(analysis.partParity[0].status).toBe("native-multi-hole");
    expect(analysis.parity.some((risk) => risk.code === "boolean.freeform")).toBe(false);
  });

  it("flags a cut that cannot become a native multi-hole extrusion", () => {
    const analysis = analyzeSpec(
      spec([
        base(
          {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 100, y: 100, z: 100 },
          },
          {
            cuts: [
              {
                kind: "cylinder",
                axis: "x",
                base: { x: -60, y: 0, z: 50 },
                radius: 8,
                height: 120,
              },
            ],
          },
        ),
      ]),
    );

    expect(analysis.partParity[0].status).toBe("freeform");
    expect(analysis.partParity[0].native).toBe(false);
    expect(analysis.parity.some((risk) => risk.code === "boolean.freeform")).toBe(true);
  });

  it("warns that bend radii are baked", () => {
    const analysis = analyzeSpec(
      spec([
        base({
          kind: "bend",
          center: { x: 0, y: 0, z: 0 },
          radius: 100,
          tubeRadius: 20,
          plane: "xy",
        }),
      ]),
    );

    expect(analysis.partParity[0].status).toBe("sweep");
    expect(analysis.parity.some((risk) => risk.code === "bend.baked-radius")).toBe(true);
  });

  it("reports a model below the studio grid", () => {
    const analysis = analyzeSpec(
      spec([
        base({
          kind: "box",
          origin: { x: 0, y: 0, z: -50 },
          size: { x: 100, y: 100, z: 100 },
        }),
      ]),
    );

    expect(analysis.parity.some((risk) => risk.code === "model.below-grid")).toBe(true);
  });
});
