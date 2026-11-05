import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpec } from "@family/spec-core";
import { design } from "../src/designer.js";
import { applyFastParameterEdit, parseFastParameterEdit } from "../src/fast-edit.js";

const spec = {
  schemaVersion: "1.0",
  name: "Rack",
  category: "Furniture",
  units: "mm",
  parameters: [
    { name: "Rack Length", type: "Length", value: 1000 },
    { name: "Mesh Width", type: "Length", formula: "[Rack Length] - 40mm" },
  ],
  materials: [],
  parts: [
    {
      id: "mesh",
      name: "Mesh",
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: "[Mesh Width]", y: 500, z: 20 },
      },
    },
  ],
};

test("parses an explicit Vietnamese parameter edit", () => {
  assert.deepEqual(parseFastParameterEdit("đổi Rack Length thành 2000 mm", spec), {
    name: "Rack Length",
    type: "Length",
    value: 2000,
  });
  assert.equal(parseFastParameterEdit("đổi Rack Length thành 2.000 mm", spec)?.value, 2000);
});

test("converts metres and applies dependent formulas", () => {
  const edit = parseFastParameterEdit("change Rack Length to 2 m", spec);
  assert.equal(edit?.value, 2000);

  const next = applyFastParameterEdit(spec, edit);
  const analysis = analyzeSpec(next);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.model.parts[0].solid.size.x, 1960);
});

test("refuses formula parameters and ambiguous requests", () => {
  assert.equal(parseFastParameterEdit("đổi Mesh Width thành 900", spec), null);
  assert.equal(
    parseFastParameterEdit("đổi Rack Length thành 2000 và Mesh Width thành 900", spec),
    null,
  );
  assert.equal(parseFastParameterEdit("làm rack dài hơn", spec), null);
});

test("design applies a precise edit without invoking the agent", async () => {
  const result = await design({
    prompt: "đổi Rack Length thành 2000 mm",
    currentSpec: spec,
    lod: 300,
    emit: () => {},
    attachments: [],
  });

  assert.equal(result.analysis.ok, true);
  assert.equal(result.stats.fastEdit?.name, "Rack Length");
  assert.equal(result.stats.attempts, 0);
  assert.equal(result.analysis.model.parts[0].solid.size.x, 1960);
});
