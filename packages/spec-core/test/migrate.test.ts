import { describe, expect, it } from "vitest";
import { analyzeSpec, CURRENT_SPEC_VERSION, migrateSpec, repairCorruptedUnits } from "../src/index.js";

describe("spec migration", () => {
  it("repairs doubled unit suffixes from legacy regex bugs", () => {
    expect(repairCorruptedUnits("([Rung Length] - [Rung Slot Length] - 1mm0mm) / 2")).toBe(
      "([Rung Length] - [Rung Slot Length] - 10mm) / 2",
    );
    expect(repairCorruptedUnits("[W] + 15mm0mm - 4mm5mm")).toBe("[W] + 150mm - 45mm");
    expect(repairCorruptedUnits("[H] - 10mmmm")).toBe("[H] - 10mm");
  });

  it("migrates legacy spec to current specVersion without mutating the source object", () => {
    const legacy = {
      name: "Legacy Elbow",
      category: "Cable Tray Fitting",
      parameters: [
        { name: "Length", type: "Length", value: 400 },
        { name: "Offset", type: "Length", formula: "[Length] - 1mm0mm" },
      ],
      parts: [
        {
          id: "plate",
          name: "Plate",
          solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Offset]", y: 100, z: "2mm0mm" } },
        },
      ],
    };
    const original = JSON.stringify(legacy);

    const result = migrateSpec(legacy);
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(CURRENT_SPEC_VERSION);
    expect(result.spec.schemaVersion).toBe("1.0");
    expect(result.spec.units).toBe("mm");
    expect(result.spec.specVersion).toBe(CURRENT_SPEC_VERSION);
    expect(JSON.stringify(legacy)).toBe(original);

    const analysis = analyzeSpec(legacy);
    expect(analysis.ok).toBe(true);
    expect(analysis.errors).toEqual([]);
    expect(analysis.parameters.byKey.get("offset")?.value).toBe(390);
  });

  it("is a no-op for already migrated specs", () => {
    const current = {
      schemaVersion: "1.0",
      specVersion: CURRENT_SPEC_VERSION,
      name: "Modern",
      category: "Generic Model",
      units: "mm",
      parameters: [{ name: "W", type: "Length", value: 100 }],
      parts: [{ id: "body", name: "Body", solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[W]", y: 50, z: 50 } }, cuts: [] }],
    };

    const result = migrateSpec(current);
    expect(result.migrated).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.spec).toBe(current);
  });
});
