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
