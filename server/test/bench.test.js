import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBenchmark } from "../../bench/run.mjs";
import { scoreBenchmarkCase } from "../../bench/score.mjs";

test("benchmark stub mode runs script verification with clear STUB labeling and side-by-side previews", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "family-bench-"));
  try {
    const report = await runBenchmark({
      stub: true,
      mode: "both",
      runs: 1,
      limit: 4,
      out,
    });

    assert.equal(report.kind, "stub-smoke-test");
    assert.equal(report.summary.before.cases, 4);
    assert.equal(report.summary.after.cases, 4);
    assert.equal(report.summary.after.passedCases, 4);
    assert.ok(
      report.summary.after.avgScore >= report.summary.before.avgScore,
      `expected after (${report.summary.after.avgScore}) >= before (${report.summary.before.avgScore})`,
    );

    const md = fs.readFileSync(path.join(out, "comparison.md"), "utf8");
    assert.ok(md.includes("STUB"), "comparison.md must clearly mark stub results");
    assert.equal(fs.existsSync(path.join(out, "report.json")), true);

    const previews = fs.readdirSync(path.join(out, "previews")).filter((f) => f.endsWith(".png"));
    // 4 before + 4 after + 4 side-by-side compare PNGs
    assert.equal(previews.length, 12);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("scorer judges geometry fairly without crediting macro presence alone", async () => {
  const { analyzeSpec } = await import("@family/spec-core");
  const elbowCase = {
    id: "fair-elbow",
    group: "tray-macro",
    supportsMacro: true,
    criteria: {
      minParts: 4,
      minConnectors: 2,
      bounds: { x: [650, 750], y: [650, 750], z: [95, 110], toleranceMm: 20 },
      requiredParams: ["width", "height"],
      requiredParts: ["bottom", "wall"],
      features: { foldedFlange: true, miteredOrChamfer: true, holesOrSlots: false },
    },
  };

  // Explicit hand-written prism parts (NO macros) matching mitred 45° elbow + top flanges
  const handBuilt = analyzeSpec({
    schemaVersion: "1.0",
    name: "HandBuilt Elbow",
    category: "Cable Tray Fitting",
    units: "mm",
    parameters: [
      { name: "Width", type: "Length", value: 400 },
      { name: "Height", type: "Length", value: 100 },
    ],
    materials: [{ name: "Steel" }],
    parts: [
      {
        id: "bottom-a",
        name: "Bottom A",
        material: "Steel",
        solid: {
          kind: "prism",
          plane: "xy",
          from: 0,
          to: 2,
          points: [
            [0, -200],
            [500, -200],
            [700, 0],
            [0, 200],
          ],
        },
      },
      {
        id: "bottom-b",
        name: "Bottom B",
        material: "Steel",
        solid: {
          kind: "prism",
          plane: "xy",
          from: 0,
          to: 2,
          points: [
            [500, 200],
            [700, 0],
            [700, 500],
            [300, 500],
          ],
        },
      },
      {
        id: "wall-outer",
        name: "Outer Wall",
        material: "Steel",
        solid: {
          kind: "prism",
          plane: "xy",
          from: 2,
          to: 100,
          points: [
            [0, -200],
            [500, -200],
            [700, 0],
            [498, -198],
          ],
        },
      },
      {
        id: "flange-top-1",
        name: "Top Lip 1",
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 250, y: -192, z: 99 },
          size: { x: "[Width]", y: 15, z: 2 },
        },
      },
      {
        id: "flange-top-2",
        name: "Top Lip 2",
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 250, y: 192, z: 99 },
          size: { x: "[Width]", y: 15, z: 2 },
        },
      },
    ],
    connectors: [
      { id: "c1", name: "In", systemType: "CableTray", shape: "rectangular", origin: { x: 0, y: 0, z: 50 }, directionVector: { x: -1, y: 0, z: 0 }, width: 400, height: 100 },
      { id: "c2", name: "Out", systemType: "CableTray", shape: "rectangular", origin: { x: 500, y: 500, z: 50 }, directionVector: { x: 0, y: 1, z: 0 }, width: 400, height: 100 },
    ],
  });

  const scored = scoreBenchmarkCase(elbowCase, handBuilt);
  assert.equal(scored.usedMacro, false);
  assert.equal(scored.featureChecks.find((c) => c.name === "miteredOrChamfer")?.actual, true);
  assert.equal(scored.featureChecks.find((c) => c.name === "foldedFlange")?.actual, true);
  assert.equal(scored.geometryQuality.severeOverlaps, 0);
});
