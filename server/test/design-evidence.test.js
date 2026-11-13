import assert from "node:assert/strict";
import test from "node:test";

import { applyResolvedValues, allowedParameterNames } from "../src/design-evidence.js";

function spec() {
  return {
    schemaVersion: "1.0",
    name: "Test",
    category: "Generic Model",
    units: "mm",
    parameters: [{ name: "Motor Frame Size", type: "Text", group: "Data", value: "90L" }],
    materials: [],
    parts: [],
    connectors: [],
    notes: [],
  };
}

test("only parameters the pack or the user named become Revit parameters", () => {
  const target = spec();
  applyResolvedValues(
    target,
    [
      { name: "Motor Frame", value: "90L", level: 4, source: "IEC 60034" },
      { name: "Duct Width", value: 400, level: 4, source: "Cỡ ống gió chuẩn" },
      { name: "Sheet Thickness", value: 1.5, level: 4, source: "Quy tắc cable-ladder" },
      { name: "Flange Bolts", value: 8, unit: "", level: 4, source: "EN 1092-1 PN16" },
    ],
    { allow: ["Motor Frame Size", "Sheet Thickness", "Flange Bolts"] },
  );

  const names = target.parameters.map((parameter) => parameter.name);
  assert.deepEqual(names, ["Motor Frame Size", "Sheet Thickness", "Flange Bolts"]);
  assert.equal(target.parameters[1].type, "Length");
  assert.equal(target.parameters[2].type, "Number");
});

test("allowedParameterNames combines the pack and the checklist", () => {
  const names = allowedParameterNames(
    { rule: { productType: "valve", parameters: [{ name: "Nominal Size" }] } },
    { parameters: [{ name: "Body Length" }] },
  );

  assert.deepEqual(names.sort(), ["Body Length", "Nominal Size"]);
});
