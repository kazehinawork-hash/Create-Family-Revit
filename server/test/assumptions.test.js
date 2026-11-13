// These tests cover the opt-in pipeline (templates, evidence, tiers, split steps).
process.env.AGENT_EXPERIMENTAL_PIPELINE = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";

import { analyzeSpec } from "@family/spec-core";

import { checkCompleteness, extractChecklistHeuristic } from "../src/checklist.js";
import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";
import { crossSpec, teeSpec } from "../src/templates/cable-ladder.js";

beforeEach(() => clearCachedResults());

const FULL_PROMPT = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "cross-prompt-full.txt"),
  "utf8",
);

function partialSpec({ withCorners = true } = {}) {
  const spec = {
    schemaVersion: "1.0",
    name: "Khung gá",
    category: "Generic Model",
    units: "mm",
    parameters: [{ name: "Height", type: "Length", group: "Dimensions", value: 100 }],
    materials: [{ name: "Steel", color: "#888888", metalness: 0.8, roughness: 0.3 }],
    parts: [
      {
        id: "body",
        name: "Body",
        material: "Steel",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 50 }, size: { x: 400, y: 300, z: 100 } },
      },
    ],
    connectors: [],
  };

  if (withCorners) {
    for (let index = 1; index <= 4; index += 1) {
      spec.parts.push({
        id: `corner-${index}-web`,
        name: `Corner Rail ${index} Web`,
        material: "Steel",
        solid: { kind: "box", origin: { x: index * 50, y: 0, z: 50 }, size: { x: 20, y: 20, z: 100 } },
      });
      spec.connectors.push({
        id: `conn-${index}`,
        name: `Connector ${index}`,
        systemType: "CableTray",
        shape: "rectangular",
        origin: { x: index * 40, y: 0, z: 50 },
        directionVector: { x: index % 2 ? 1 : 0, y: index % 2 ? 0 : 1, z: 0 },
        width: 100,
        height: 100,
      });
    }
  }

  return spec;
}

test("a brief without dimensions still builds the cross template, with assumption notes", async () => {
  let calls = 0;
  const result = await design({
    prompt: "Tạo ngã tư thang cáp 400x100",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    generate: async () => {
      calls += 1;
      throw new Error("the template must not call the model");
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.stats.tierLabel, "template");
  assert.equal(result.stats.complete, true);
  assert.ok(
    (result.analysis.spec.notes ?? []).some((note) => note.startsWith("Giả định:")),
    "notes must list the assumed standard values",
  );
});

test("the full cross brief (with Bend Radius = 0) keeps the template", async () => {
  const checklist = extractChecklistHeuristic(FULL_PROMPT);
  const names = checklist.parameters.map((entry) => entry.name);

  assert.ok(names.includes("Ladder Width 1"));
  assert.ok(names.includes("Ladder Width 2"));
  assert.ok(names.includes("Ladder Height"));
  assert.ok(names.includes("Tangent Length"));
  assert.ok(names.includes("Miter Offset"));
  assert.ok(!names.includes("Bend Radius"), "a zero constraint is not a required parameter");
  assert.ok(!names.some((name) => /^[XYZ]\d?$/.test(name)), "coordinates are not parameters");
  assert.ok(!names.includes("W"), "formula right-hand sides are not parameters");

  const values = Object.fromEntries(checklist.parameters.map((entry) => [entry.name, entry.value]));
  assert.equal(values["Ladder Width 1"], 400);
  assert.equal(values["Ladder Width 2"], 400);
  assert.equal(values["Ladder Height"], 100);
  assert.equal(values["Tangent Length"], 120);
  assert.equal(values["Miter Offset"], 150);
  assert.equal(values["Rung Pitch"], 300);

  let calls = 0;
  const result = await design({
    prompt: FULL_PROMPT,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    generate: async () => {
      calls += 1;
      throw new Error("Bend Radius must not disqualify the template");
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.stats.tierLabel, "template");
  assert.equal(result.stats.complete, true);

  const analysis = analyzeSpec(result.analysis.spec);
  assert.equal(analysis.ok, true);
  assert.equal(Math.round(analysis.model.bounds.size.x), 940);
  assert.equal(Math.round(analysis.model.bounds.size.y), 940);
  assert.equal(result.analysis.spec.connectors.length, 4);

  // "Rung Pitch" is named by the brief but not declared by the template: it is
  // inserted instead of marking the family incomplete.
  assert.ok(
    (result.analysis.spec.parameters ?? []).some((param) => param.name === "Rung Pitch"),
    "the named parameter is added to the spec",
  );
});

test("a parameter named in the brief is added when the model leaves it out", async () => {
  const prompt = "tạo khung gá 4 thành góc vát và 4 connector, Width = 500 mm";
  const generate = async () => ({ json: partialSpec(), text: "", usage: null });

  const result = await design({
    prompt,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    generate,
  });

  const width = (result.analysis.spec.parameters ?? []).find((param) => param.name === "Width");
  assert.ok(width, "the missing parameter is inserted");
  assert.equal(width.value, 500);
  assert.equal(width.type, "Length");
  assert.equal(result.stats.complete, true);
  assert.deepEqual(result.stats.missing, []);
  assert.ok(
    (result.analysis.spec.notes ?? []).some((note) => note.includes("Width = 500")),
    "the insertion is noted",
  );
});

test("a missing parameter never makes the spec incomplete", () => {
  const checklist = { groups: [], connectors: 0, parameters: [{ name: "Width", value: 500 }], requiresMaterials: false };
  const result = checkCompleteness(partialSpec(), checklist);

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.parametersMissing, ["Width"]);
  assert.deepEqual(result.missing, []);
});

test("teeSpec honours the numbers from the brief", () => {
  const spec = teeSpec({ ladderWidth1: 600 });
  const width = spec.parameters.find((param) => param.name === "Ladder Width 1");
  const analysis = analyzeSpec(spec);

  assert.equal(width.value, 600);
  assert.equal(analysis.ok, true);
  assert.ok(analysis.model.bounds.size.x > 600, "the tee grows with the 600 mm width");
});

test("crossSpec still respects its own defaults", () => {
  const spec = crossSpec();
  const analysis = analyzeSpec(spec);
  assert.equal(Math.round(analysis.model.bounds.size.x), 940);
  assert.equal(spec.connectors.length, 4);
});
