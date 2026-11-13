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

beforeEach(() => clearCachedResults());

const CROSS_PROMPT = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "cross-prompt.txt"),
  "utf8",
);

const BRACE_PROMPT = "tạo khung gá 4 thành góc vát và 4 connector cho hệ thép";

function boxSpec(name = "Khung gá") {
  return {
    schemaVersion: "1.0",
    name,
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Length", type: "Length", group: "Dimensions", value: 400 },
      { name: "Height", type: "Length", group: "Dimensions", value: 100 },
    ],
    materials: [{ name: "Steel", color: "#888888", metalness: 0.8, roughness: 0.3 }],
    parts: [
      {
        id: "body",
        name: "Body",
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 0, y: 0, z: 50 },
          size: { x: "[Length]", y: 300, z: "[Height]" },
        },
      },
    ],
    connectors: [],
  };
}

function completeCornerSpec() {
  const spec = boxSpec("Khung gá đầy đủ");
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
  return spec;
}

test("a known cable-ladder family is built from the template with no model call", async () => {
  let calls = 0;
  const result = await design({
    prompt: CROSS_PROMPT,
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
  assert.equal(result.stats.modelCalls, 0);
  assert.equal(result.stats.complete, true);
  assert.ok(result.stats.checklist, "the checklist is stored with the result");

  const analysis = analyzeSpec(result.analysis.spec);
  assert.equal(analysis.ok, true);
  const bounds = analysis.model.bounds.size;
  assert.equal(Math.round(bounds.x), 940);
  assert.equal(Math.round(bounds.y), 940);
  assert.equal(Math.round(bounds.z), 100);
  assert.equal(result.analysis.spec.connectors.length, 4);
});

test("an incomplete creation is supplemented and only the missing items are requested", async () => {
  const prompts = [];
  const generate = async (messages) => {
    prompts.push(messages[messages.length - 1].content);
    return {
      json: prompts.length === 1 ? boxSpec() : completeCornerSpec(),
      text: "",
      usage: null,
    };
  };

  const result = await design({
    prompt: BRACE_PROMPT,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    generate,
  });

  assert.equal(prompts.length, 2, "one creation call + one supplement call");
  assert.match(prompts[1], /Add ONLY these/);
  assert.match(prompts[1], /4 thành góc vát/);
  assert.match(prompts[1], /4 connector/);
  assert.equal(result.stats.complete, true);
  assert.deepEqual(result.stats.missing, []);
  assert.equal(result.analysis.spec.connectors.length, 4);
});

test("still incomplete after two supplements: escalate, then report red warnings", async () => {
  const prompts = [];
  const generate = async (messages) => {
    prompts.push(messages[messages.length - 1].content);
    // Always valid, never complete.
    return { json: boxSpec(`Attempt ${prompts.length}`), text: "", usage: null };
  };

  const result = await design({
    prompt: BRACE_PROMPT,
    currentSpec: null,
    lod: 300,
    emit: () => {},
    generate,
  });

  assert.equal(prompts.length, 3, "creation + 2 supplements, then stop");
  assert.equal(result.stats.complete, false);
  assert.ok(result.stats.missing.some((text) => /thành góc/.test(text)));
  assert.ok(result.stats.missing.some((text) => /connector/.test(text)));
  assert.ok(
    result.stats.warnings.some((text) => text.startsWith("Chưa đầy đủ:")),
    "the chat warning lists what is missing",
  );

  // The second supplement must use the stronger tier.
  assert.equal(result.stats.tier, 3);
});

test("the stored checklist covers groups, connectors, parameters and materials", () => {
  const checklist = extractChecklistHeuristic(CROSS_PROMPT);
  const result = checkCompleteness(completeCornerSpec(), checklist, {
    bounds: { x: 400, y: 300, z: 100 },
  });

  // The fixture has no rungs and misses some parameters, so it is not complete —
  // but the corner and connector groups are satisfied.
  assert.equal(result.summary.partUnits.corner, 4);
  assert.equal(result.summary.connectors, 4);
  assert.ok(!result.missing.some((item) => item.role === "corner"));
  assert.ok(!result.missing.some((item) => item.kind === "connectors"));
});
