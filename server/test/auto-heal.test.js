import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpec } from "@family/spec-core";
import { autoHealSpec } from "../src/designer.js";

function loftSpec(extra = {}) {
  return {
    schemaVersion: "1.0",
    name: "Transition",
    category: "Duct Transition",
    units: "mm",
    parameters: [],
    materials: [],
    parts: [
      {
        id: "transition",
        name: "Transition",
        solid: {
          kind: "loft",
          axis: "z",
          segments: 16,
          sections: [
            { at: 0, profile: { kind: "circle", radius: 50 } },
            { at: 100, profile: { kind: "circle", radius: 70 } },
            { at: 200, profile: { kind: "circle", radius: 50 } },
          ],
        },
        ...extra,
      },
    ],
  };
}

test("splits a loft with more than two sections into chained two-section parts", () => {
  const healed = autoHealSpec(loftSpec());

  assert.equal(healed.parts.length, 2);
  assert.equal(healed.parts[0].id, "transition-seg1");
  assert.equal(healed.parts[1].id, "transition-seg2");
  assert.equal(healed.parts[0].solid.sections.length, 2);
  assert.equal(healed.parts[1].solid.sections.length, 2);
  assert.deepEqual(
    healed.parts[0].solid.sections.map((section) => section.at),
    [0, 100],
  );
  assert.deepEqual(
    healed.parts[1].solid.sections.map((section) => section.at),
    [100, 200],
  );
  assert.ok(healed.notes?.some((note) => note.includes("2-section")));

  const analysis = analyzeSpec(healed);
  assert.equal(analysis.ok, true);
  assert.equal(
    analysis.partParity.some((part) => part.status === "multi-section"),
    false,
  );
});

test("leaves a multi-section loft with cuts alone so the cut stays on one part", () => {
  const healed = autoHealSpec(
    loftSpec({
      cuts: [
        {
          kind: "cylinder",
          axis: "z",
          base: { x: 0, y: 0, z: 0 },
          radius: 10,
          height: 250,
        },
      ],
    }),
  );

  assert.equal(healed.parts.length, 1);
  const analysis = analyzeSpec(healed);
  assert.ok(analysis.partParity[0].risks.some((risk) => risk.code === "loft.multi-section"));
  assert.ok(analysis.partParity[0].risks.some((risk) => risk.code === "boolean.freeform"));
});

test("does not touch a loft that already has two sections", () => {
  const spec = loftSpec();
  spec.parts[0].solid.sections = spec.parts[0].solid.sections.slice(0, 2);
  const healed = autoHealSpec(spec);

  assert.equal(healed.parts.length, 1);
  assert.equal(healed.parts[0].id, "transition");
});

test("expands trayRun macros into parts, connectors and default material during auto-heal", () => {
  const healed = autoHealSpec({
    schemaVersion: "1.0",
    name: "Máng cáp vát góc",
    category: "Cable Tray Fitting",
    units: "mm",
    parameters: [
      { name: "Tray Width", type: "Length", value: 400 },
      { name: "Tray Height", type: "Length", value: 100 },
      { name: "Sheet Thickness", type: "Length", value: 1.5 },
      { name: "Flange Width", type: "Length", value: 15 },
    ],
    parts: [],
    macros: [
      {
        kind: "trayRun",
        id: "tray-main",
        material: "Galvanized",
        width: "[Tray Width]",
        height: "[Tray Height]",
        thickness: "[Sheet Thickness]",
        flange: "[Flange Width]",
        segments: [
          { kind: "straight", length: 800 },
          { kind: "bend", angle: 90, direction: "left" },
          { kind: "straight", length: 600 },
        ],
      },
    ],
  });

  assert.equal(healed.parts.length, 10);
  assert.equal(healed.connectors.length, 2);
  assert.ok(healed.materials.some((m) => m.name === "Galvanized"));
  const analysis = analyzeSpec(healed);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.errors.length, 0);
});

test("auto-heal adds mm to bare offset without corrupting multi-digit mm literals", () => {
  const healed = autoHealSpec({
    schemaVersion: "1.0",
    name: "Formula unit safety",
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Width", type: "Length", value: 400 },
      { name: "KeepUnit", type: "Length", formula: "[Width] - 10mm" },
      { name: "AddUnit", type: "Length", formula: "[Width] - 25" },
    ],
    parts: [
      {
        id: "box",
        name: "Box",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[KeepUnit]", y: "[AddUnit]", z: 50 } },
      },
    ],
  });

  assert.equal(healed.parameters.find((p) => p.name === "KeepUnit").formula, "[Width] - 10mm");
  assert.equal(healed.parameters.find((p) => p.name === "AddUnit").formula, "[Width] - 25mm");
});
