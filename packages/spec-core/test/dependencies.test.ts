import { describe, expect, it } from "vitest";
import {
  buildParameterGraph,
  collectConnectorDependencies,
  collectPartDependencies,
  parameterDependencySummary,
} from "../src/dependencies.js";
import type { FamilyParameter, FamilySpec } from "../src/types.js";

const parameters: FamilyParameter[] = [
  { name: "Rack Length", type: "Length", value: 1000 },
  { name: "Mesh Width", type: "Length", formula: "[Rack Length] - 40mm" },
  { name: "Mesh Count", type: "Integer", formula: "rounddown([Mesh Width] / 50mm) + 1" },
  { name: "Unrelated", type: "Length", value: 10 },
];

describe("parameter dependency graph", () => {
  it("tracks direct and transitive formula dependencies", () => {
    const graph = buildParameterGraph(parameters);

    expect(graph.byKey.get("mesh width")?.dependsOn).toEqual(["Rack Length"]);
    expect(graph.byKey.get("rack length")?.dependents).toEqual(["Mesh Width"]);
    expect(graph.impactOf(["Rack Length"])).toEqual(["Mesh Width", "Mesh Count"]);
  });

  it("maps parts to the parameters they consume", () => {
    const spec: FamilySpec = {
      schemaVersion: "1.0",
      name: "Test",
      category: "Furniture",
      units: "mm",
      parameters,
      materials: [],
      parts: [
        {
          id: "shelf",
          name: "Shelf",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: "[Mesh Width]", y: 10, z: 10 },
          },
        },
        {
          id: "leg",
          name: "Leg",
          solid: {
            kind: "box",
            origin: { x: 0, y: 0, z: 0 },
            size: { x: "[Unrelated]", y: 10, z: 10 },
          },
        },
      ],
    };

    expect(collectPartDependencies(spec)).toEqual([
      { id: "shelf", name: "Shelf", parameters: ["Mesh Width"] },
      { id: "leg", name: "Leg", parameters: ["Unrelated"] },
    ]);
    const summary = parameterDependencySummary(spec);
    expect(summary).toContain("Rack Length -> Mesh Width, Mesh Count");
    expect(summary).toContain("parts: Shelf");

    const focused = parameterDependencySummary(spec, 6000, "đổi Rack Length thành 2000");
    expect(focused).toContain("Rack Length");
    expect(focused).not.toContain("Unrelated");
  });

  it("includes connectors that consume a parameter", () => {
    const spec: FamilySpec = {
      schemaVersion: "1.0",
      name: "Test",
      category: "Mechanical Equipment",
      units: "mm",
      parameters: [
        { name: "Base Height", type: "Length", value: 100 },
        { name: "Duct Diameter", type: "Length", formula: "[Base Height] / 2" },
      ],
      materials: [],
      parts: [],
      connectors: [
        {
          id: "sa",
          name: "Supply Air",
          systemType: "Supply Air",
          shape: "round",
          direction: "out",
          origin: { x: 0, y: 0, z: "[Base Height]" },
          diameter: "[Duct Diameter]",
        },
      ],
    };

    expect(collectConnectorDependencies(spec)).toEqual([
      { id: "sa", name: "Supply Air", parameters: ["Base Height", "Duct Diameter"] },
    ]);
    expect(parameterDependencySummary(spec)).toContain("connectors: Supply Air");
  });
});
