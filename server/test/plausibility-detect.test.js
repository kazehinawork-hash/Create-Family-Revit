import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSpec } from "@family/spec-core";

import { checkPlausibility } from "../src/plausibility.js";
import { detectProductType } from "../src/rules.js";

function plateSpec() {
  return {
    schemaVersion: "1.0",
    name: "Perforated Plate",
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Plate Width", type: "Length", group: "Dimensions", value: 400 },
      { name: "Plate Height", type: "Length", group: "Dimensions", value: 300 },
      { name: "Plate Thickness", type: "Length", group: "Dimensions", value: 6 },
      { name: "Hole Offset", type: "Length", group: "Dimensions", value: 185 },
      { name: "Hole Size", type: "Length", group: "Dimensions", value: 20 },
    ],
    materials: [{ name: "Steel", color: "#888888", metalness: 0.8, roughness: 0.3 }],
    parts: [
      {
        id: "plate",
        name: "Plate",
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 0, y: 0, z: 3 },
          // Expressions: the check must run on the solved geometry.
          size: { x: "[Plate Width]", y: "[Plate Height]", z: "[Plate Thickness]" },
        },
        cuts: [
          {
            kind: "box",
            origin: { x: "[Hole Offset]", y: 0, z: 3 },
            size: { x: "[Hole Size]", y: "[Hole Size]", z: "[Plate Thickness] + 2" },
          },
        ],
      },
    ],
    connectors: [],
    notes: [],
  };
}

test("a parametrised hole too close to the edge is detected on the solved model", () => {
  const spec = plateSpec();
  // Hole centre at x=185 on a 400 wide plate leaves 10 mm from the edge: < 1.5d.
  const issues = checkPlausibility(spec, { analysis: analyzeSpec(spec) });

  const hole = issues.find((issue) => issue.code === "hole-close-to-edge");
  assert.ok(hole, JSON.stringify(issues));
});

test("a hole with enough edge distance passes", () => {
  const spec = plateSpec();
  spec.parameters.find((parameter) => parameter.name === "Hole Offset").value = 160;

  const issues = checkPlausibility(spec, { analysis: analyzeSpec(spec) });
  assert.ok(!issues.some((issue) => issue.code === "hole-close-to-edge"));
});

test("array.count matches the evidence count", () => {
  const spec = {
    schemaVersion: "1.0",
    name: "Ladder",
    category: "Electrical Equipment",
    units: "mm",
    parameters: [{ name: "Ladder Width", type: "Length", group: "Dimensions", value: 400 }],
    materials: [{ name: "Steel", color: "#888888" }],
    parts: [
      {
        id: "rung",
        name: "Rung",
        material: "Steel",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 10 }, size: { x: 35, y: 400, z: 15 } },
        array: { count: 6, axis: "x", spacing: 300 },
      },
    ],
    connectors: [],
    notes: [],
  };

  const issues = checkPlausibility(spec, {
    analysis: analyzeSpec(spec),
    evidence: { components: [{ kind: "rung", count: 6 }] },
  });

  assert.ok(!issues.some((issue) => issue.code === "component-count"), JSON.stringify(issues));
});

test("product detection distinguishes đèn from đen/đến", () => {
  for (const prompt of ["ống thép đen DN50", "gioăng cao su đen", "sơn tĩnh điện màu đen", "đi đến tủ"]) {
    const detected = detectProductType({ prompt });
    assert.notEqual(detected?.productType, "light-fixture", prompt);
  }

  assert.equal(detectProductType({ prompt: "đèn panel LED 600x600" })?.productType, "light-fixture");
});

test("longer phrases win the product type", () => {
  assert.equal(detectProductType({ prompt: "ngã tư thang cáp 400x100" })?.productType, "cable-ladder");
  assert.equal(detectProductType({ prompt: "van bướm DN150 PN16" })?.productType, "valve");
  assert.equal(detectProductType({ prompt: "quạt hướng trục Ø500" })?.productType, "fan");
});
