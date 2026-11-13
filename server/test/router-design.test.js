// These tests cover the opt-in pipeline (templates, evidence, tiers, split steps).
process.env.AGENT_EXPERIMENTAL_PIPELINE = "1";

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";

beforeEach(() => clearCachedResults());

function spec() {
  return {
    schemaVersion: "1.0",
    name: "Mitered Tee",
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Ladder Width 1", type: "Length", group: "Dimensions", value: 400 },
      { name: "Ladder Height", type: "Length", group: "Dimensions", value: 100 },
    ],
    materials: [{ name: "Steel", color: "#888888", metalness: 0.8, roughness: 0.3 }],
    parts: [
      {
        id: "body",
        name: "Body",
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: "[Ladder Width 1]", y: 300, z: "[Ladder Height]" },
        },
      },
    ],
    connectors: [],
  };
}

function validSpec(name = "Box") {
  return {
    schemaVersion: "1.0",
    name,
    category: "Generic Model",
    units: "mm",
    parameters: [{ name: "Length", type: "Length", group: "Dimensions", value: 300 }],
    materials: [{ name: "Steel", color: "#888888", metalness: 0.8, roughness: 0.3 }],
    parts: [
      {
        id: "body",
        name: "Body",
        material: "Steel",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Length]", y: 200, z: 100 } },
      },
    ],
    connectors: [],
  };
}

function brokenSpec() {
  const specValue = validSpec("Broken");
  specValue.parts = [{ id: "body", name: "Body" }];
  return specValue;
}

test("a patch that leaves errors is escalated to one repair pass with the issue list", async () => {
  const calls = [];
  const generate = async (messages, options) => {
    calls.push({ model: options?.model, prompt: messages[messages.length - 1].content });
    return calls.length === 1
      ? { json: brokenSpec(), text: "", usage: null }
      : { json: validSpec("Fixed"), text: "", usage: null };
  };

  const result = await design({
    prompt: "thêm connector branch ở mặt bên",
    currentSpec: spec(),
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate,
  });

  assert.equal(calls.length, 2, "one patch call + one repair call");
  assert.equal(result.stats.tier, 3);
  assert.equal(result.stats.tierLabel, "repair");
  assert.equal(result.stats.modelCalls, 2);
  assert.match(calls[1].prompt, /Problem|parts\.|no solid|missing/i);
  assert.ok(calls[1].prompt.length < 8000, "the repair prompt is not the whole spec");

  // The patch prompt is the compact summary, not JSON.stringify(spec). (The JSON
  // output contract at the end still shows the required top-level shape.)
  const requestPart = calls[0].prompt.split("\n\n---\n")[0];
  assert.ok(!requestPart.includes('"schemaVersion"'));
  assert.ok(requestPart.length < 4000);
});

test("a clean patch stays on tier 1 with a single model call", async () => {
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return { json: validSpec("Patched"), text: "", usage: null };
  };

  const result = await design({
    prompt: "thêm connector branch ở mặt bên",
    currentSpec: spec(),
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate,
  });

  assert.equal(calls, 1);
  assert.equal(result.stats.tier, 1);
  assert.equal(result.stats.tierLabel, "patch");
  assert.equal(result.stats.modelCalls, 1);
  assert.ok(result.stats.promptChars > 0);
});

test("a repeated request is answered from cache without touching the model", async () => {
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return { json: validSpec("Cached"), text: "", usage: null };
  };

  const prompt = "thêm một connector ở cạnh bên và giữ nguyên các part khác";

  const first = await design({ prompt, currentSpec: spec(), lod: 300, emit: () => {}, model: "cheap-model", generate });
  assert.equal(calls, 1);
  assert.ok(!first.stats.cached);

  const second = await design({ prompt, currentSpec: spec(), lod: 300, emit: () => {}, model: "cheap-model", generate });
  assert.equal(calls, 1, "the second run must not call the model");
  assert.equal(second.stats.cached, true);
  assert.equal(second.stats.modelCalls, 0);
  assert.equal(second.stats.savedCalls, 2);
});

test("a deterministic edit reports tier 0 and one saved call", async () => {
  const result = await design({
    prompt: "tăng Ladder Height thêm 20mm",
    currentSpec: spec(),
    lod: 300,
    emit: () => {},
    generate: async () => {
      throw new Error("must not be called");
    },
  });

  assert.equal(result.stats.tier, 0);
  assert.equal(result.stats.tierLabel, "fast-edit");
  assert.equal(result.stats.modelCalls, 0);
  assert.equal(result.stats.savedCalls, 1);
  assert.equal(result.analysis.spec.parameters.find((p) => p.name === "Ladder Height").value, 120);
});
