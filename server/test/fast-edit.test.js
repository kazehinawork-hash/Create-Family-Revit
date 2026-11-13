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

test("supports relative adjustment (tăng / giảm)", () => {
  const inc = parseFastParameterEdit("tăng Rack Length thêm 200 mm", spec);
  assert.equal(inc?.value, 1200);

  const dec = parseFastParameterEdit("giảm Rack Length 150", spec);
  assert.equal(dec?.value, 850);
});

test("supports direct material and part color edits", () => {
  const specWithMat = {
    ...spec,
    materials: [{ name: "Steel", color: "#888888" }],
  };
  const colorEdit = parseFastParameterEdit("đổi màu Steel thành đỏ", specWithMat);
  assert.equal(colorEdit?.kind, "material-color");
  assert.equal(colorEdit?.color, "#ff2222");

  const applied = applyFastParameterEdit(specWithMat, colorEdit);
  assert.equal(applied.materials[0].color, "#ff2222");
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

/* ---------------------------------------------------------------- extended parser */

function teeSpec() {
  return {
    schemaVersion: "1.0",
    name: "Mitered Tee",
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Ladder Width 1", type: "Length", value: 400 },
      { name: "Ladder Width 2", type: "Length", value: 300 },
      { name: "Ladder Height", type: "Length", value: 100 },
      { name: "Lower Run Length", type: "Length", value: 150 },
      { name: "Tangent Length", type: "Length", value: 120 },
      { name: "Branch Throat Length", type: "Length", value: 240 },
      { name: "Bend Angle", type: "Angle", value: 45 },
      { name: "Miter Offset", type: "Length", formula: "[Ladder Height] / 2" },
    ],
    materials: [{ name: "Steel", color: "#888888", metalness: 0.8, roughness: 0.3 }],
    parts: [
      { id: "web-a", name: "Side Web Near", material: "Steel", solid: { kind: "box" } },
      { id: "web-b", name: "Side Web Far", material: "Steel", solid: { kind: "box" } },
    ],
    connectors: [],
  };
}

test("extended fast-edit: Vietnamese and English phrasings", () => {
  const cases = [
    ["đổi Ladder Width 1 thành 400", "Ladder Width 1", 400],
    ["set Ladder Width 2 to 300", "Ladder Width 2", 300],
    ["tăng Ladder Height thêm 20mm", "Ladder Height", 120],
    ["giảm Ladder Height 10", "Ladder Height", 90],
    ["cộng thêm 5 cm vào Lower Run Length", "Lower Run Length", 200],
    ["đổi Ladder Width 2 thành 40 cm", "Ladder Width 2", 400],
    ["set Lower Run Length to 1.5 m", "Lower Run Length", 1500],
    ["tăng Tangent Length 2 inch", "Tangent Length", 170.8],
    ["nhân đôi Branch Throat Length", "Branch Throat Length", 480],
    ["gấp đôi Ladder Width 2", "Ladder Width 2", 600],
    ["giảm một nửa Ladder Width 1", "Ladder Width 1", 200],
    ["tăng Ladder Height 10%", "Ladder Height", 110],
    ["giảm Tangent Length 25 percent", "Tangent Length", 90],
    ["đổi bend angle thành 30 deg", "Bend Angle", 30],
  ];

  for (const [prompt, name, value] of cases) {
    const edit = parseFastParameterEdit(prompt, teeSpec());
    assert.ok(edit, `expected an edit for: ${prompt}`);
    assert.equal(edit.name, name, prompt);
    assert.equal(Math.round(edit.value * 100) / 100, value, prompt);
  }
});

test("extended fast-edit: typos, multiple parameters, ambiguity", () => {
  const typo = parseFastParameterEdit("đổi ladder widht 1 thành 500", teeSpec());
  assert.equal(typo?.name, "Ladder Width 1");
  assert.equal(typo?.value, 500);

  const multi = parseFastParameterEdit(
    "đổi Ladder Width 1 thành 500 và Ladder Width 2 thành 250, tăng Ladder Height thêm 20mm",
    teeSpec(),
  );
  const changes = multi?.changes ?? [multi];
  assert.equal(changes.length, 3);

  const applied = applyFastParameterEdit(teeSpec(), multi);
  const values = Object.fromEntries(applied.parameters.map((param) => [param.name, param.value]));
  assert.equal(values["Ladder Width 1"], 500);
  assert.equal(values["Ladder Width 2"], 250);
  assert.equal(values["Ladder Height"], 120);

  assert.equal(parseFastParameterEdit("đổi Ladder Width thành 400", teeSpec()), null);
  assert.equal(parseFastParameterEdit("tăng chiều rộng 10%", teeSpec()), null);
});

test("extended fast-edit: rename, colour, material assignment", () => {
  const rename = parseFastParameterEdit("đổi tên Ladder Width 1 thành Máng rộng", teeSpec());
  assert.equal(rename?.kind, "rename");
  assert.equal(rename?.target, "parameter");
  assert.equal(applyFastParameterEdit(teeSpec(), rename).parameters[0].name, "Máng rộng");

  const color = parseFastParameterEdit("đổi màu Steel thành đỏ", teeSpec());
  assert.equal(color?.kind, "material-color");
  assert.equal(applyFastParameterEdit(teeSpec(), color).materials[0].color, "#ff2222");

  const assign = parseFastParameterEdit("gán vật liệu cho Side Web Near thành Steel", teeSpec());
  assert.equal(assign?.kind, "material-assign");
  assert.equal(assign?.partId, "web-a");
});
