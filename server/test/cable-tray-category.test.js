import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpec } from "@family/spec-core";

import { autoHealSpec } from "../src/designer.js";
import { crossSpec, elbowSpec, teeSpec } from "../src/templates/cable-ladder.js";

test("cable-ladder fittings are Cable Tray Fitting with a part type", () => {
  const cases = [
    [crossSpec(), "Cross"],
    [teeSpec(), "Tee"],
    [elbowSpec(), "Elbow"],
  ];

  for (const [spec, partType] of cases) {
    assert.equal(spec.category, "Cable Tray Fitting", `${spec.name} category`);
    assert.equal(spec.partType, partType, `${spec.name} part type`);
    assert.ok(spec.connectors.length > 0, `${spec.name} has connectors`);
    for (const connector of spec.connectors) {
      assert.equal(connector.systemType, "CableTray");
    }
  }

  const elbow = elbowSpec();
  assert.equal(elbow.macros?.length, 1);
  const elbowAnalysis = analyzeSpec(elbow);
  assert.equal(elbowAnalysis.ok, true);
  assert.equal(elbowAnalysis.errors.length, 0);
});

test("cable-tray fitting aliases heal to the Revit category", () => {
  const base = () => ({ ...crossSpec(), category: "Electrical Equipment" });

  for (const alias of [
    "cable tray fitting",
    "CableTrayFitting",
    "cable ladder fitting",
    "Phụ kiện thang cáp",
    "phụ kiện máng cáp",
  ]) {
    const healed = autoHealSpec({ ...base(), category: alias });
    assert.equal(healed.category, "Cable Tray Fitting", `alias "${alias}"`);
  }

  // A plain tray is not a fitting and keeps its own category.
  const tray = autoHealSpec({ ...base(), category: "Electrical Equipment" });
  assert.equal(tray.category, "Electrical Equipment");
});
