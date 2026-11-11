import { describe, expect, it } from "vitest";
import { analyzeSpec } from "../src/analyze.js";
import type { FamilySpec } from "../src/types.js";

function base(overrides: Partial<FamilySpec> = {}): FamilySpec {
  return {
    schemaVersion: "1.0",
    name: "Health",
    category: "Furniture",
    units: "mm",
    parameters: [],
    materials: [],
    parts: [],
    ...overrides,
  };
}

describe("geometry health checks", () => {
  it("flags a resolved zero-size part", () => {
    const spec = base({
      parameters: [{ name: "Width", type: "Length", value: 0 }],
      parts: [
        {
          id: "plate",
          name: "Plate",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: "[Width]", y: 10, z: 10 },
          },
        },
      ],
    });

    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(false);
    expect(analysis.errors.some((issue) => issue.path === "logic.geometry.plate")).toBe(true);
  });

  it("warns when a cut misses its host", () => {
    const spec = base({
      parts: [
        {
          id: "body",
          name: "Body",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 100, y: 100, z: 10 },
          },
          cuts: [
            {
              kind: "cylinder",
              axis: "z",
              base: { x: 1000, y: 1000, z: 0 },
              radius: 5,
              height: 10,
            },
          ],
        },
      ],
    });

    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(true);
    expect(
      analysis.issues.some(
        (issue) => issue.severity === "warning" && issue.path === "logic.geometry.body",
      ),
    ).toBe(true);
  });

  it("warns when array copies overlap", () => {
    const spec = base({
      parts: [
        {
          id: "fin",
          name: "Fin",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 10, y: 100, z: 100 },
          },
          array: { count: 3, axis: "x", spacing: 0 },
        },
      ],
    });

    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(true);
    expect(
      analysis.issues.some(
        (issue) => issue.path === "logic.geometry.fin" && /spacing/.test(issue.message),
      ),
    ).toBe(true);
  });

  it("warns when a model exceeds the LOD 400 part budget", () => {
    const parts = Array.from({ length: 151 }, (_, index) => ({
      id: `fin-${index}`,
      name: `Fin ${index}`,
      solid: {
        kind: "box" as const,
        origin: { x: index * 20, y: 0, z: 0 },
        size: { x: 10, y: 100, z: 100 },
      },
    }));

    const analysis = analyzeSpec(base({ lod: 400, parts }));
    expect(analysis.ok).toBe(true);
    expect(analysis.issues.some((issue) => issue.path === "lod.parts")).toBe(true);
  });

  it("warns when geometry is smaller than Revit ShortCurveTolerance (0.8mm)", () => {
    const spec = base({
      parts: [
        {
          id: "tiny-plate",
          name: "Tiny Plate",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 0.5, y: 10, z: 10 },
          },
        },
      ],
    });

    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(true);
    expect(
      analysis.issues.some(
        (issue) =>
          issue.severity === "warning" &&
          issue.path === "logic.geometry.tiny-plate" &&
          issue.message.includes("Revit tolerance"),
      ),
    ).toBe(true);
  });

  it("warns when connector origin is orphaned away from solids", () => {
    const spec = base({
      parts: [
        {
          id: "body",
          name: "Body",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 100, y: 100, z: 100 },
          },
        },
      ],
      connectors: [
        {
          id: "c1",
          name: "Inlet",
          systemType: "hydronicsupply",
          shape: "round",
          origin: { x: 500, y: 500, z: 500 },
          directionVector: { x: 0, y: 0, z: 1 },
          diameter: 50,
        },
      ],
    });

    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(true);
    expect(
      analysis.issues.some(
        (issue) =>
          issue.severity === "warning" &&
          issue.path === "logic.geometry.connector.c1" &&
          issue.message.includes("orphaned"),
      ),
    ).toBe(true);
  });

  it("does not warn when the connector is explicitly hosted on a reference plane", () => {
    const spec = base({
      parts: [
        {
          id: "body",
          name: "Body",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: 100, y: 100, z: 100 },
          },
        },
      ],
      connectors: [
        {
          id: "c1",
          name: "Inlet",
          systemType: "hydronicsupply",
          shape: "round",
          host: "reference-plane",
          origin: { x: 500, y: 500, z: 500 },
          directionVector: { x: 0, y: 0, z: 1 },
          diameter: 50,
        },
      ],
    });

    const analysis = analyzeSpec(spec);
    expect(analysis.ok).toBe(true);
    expect(
      analysis.issues.some(
        (issue) =>
          issue.path === "logic.geometry.connector.c1" &&
          issue.message.includes("orphaned"),
      ),
    ).toBe(false);
  });
});
