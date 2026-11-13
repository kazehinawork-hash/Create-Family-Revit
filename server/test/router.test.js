import assert from "node:assert/strict";
import test from "node:test";

import { autoHealSpec } from "../src/designer.js";
import {
  TIER,
  affectedContext,
  buildTierPrompt,
  cacheSignature,
  chooseTierModels,
  classifyRequest,
  limitPrompt,
  modelForTier,
  strongerAvailableModel,
  summarizeSpec,
} from "../src/router.js";

function spec() {
  return {
    schemaVersion: "1.0",
    name: "Mitered Tee",
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Ladder Width 1", type: "Length", group: "Dimensions", value: 400 },
      { name: "Ladder Width 2", type: "Length", group: "Dimensions", value: 300 },
      { name: "Ladder Height", type: "Length", group: "Dimensions", value: 100 },
      { name: "Miter Offset", type: "Length", group: "Dimensions", formula: "[Ladder Height] / 2" },
    ],
    materials: [{ name: "Steel", color: "#888888" }],
    parts: [
      { id: "body", name: "Body", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 400, y: 300, z: 100 } } },
    ],
    connectors: [],
  };
}

test("classifyRequest: fast-edit, local change, structural change, new family", () => {
  assert.equal(classifyRequest("đổi Ladder Width 1 thành 500", { spec: spec() }).tier, TIER.FAST);

  assert.equal(
    classifyRequest("thêm connector branch ở mặt bên", { spec: spec() }).tier,
    TIER.PATCH,
  );
  assert.equal(
    classifyRequest("add a rung near the end", { spec: spec() }).tier,
    TIER.PATCH,
  );

  assert.equal(
    classifyRequest("thiết kế lại family này thành tee 3 nhánh", { spec: spec() }).tier,
    TIER.STRUCTURE,
  );
  assert.equal(classifyRequest("tạo tee 400x300", { spec: null }).tier, TIER.STRUCTURE);
});

test("classifyRequest never guesses an ambiguous edit", () => {
  // Both parameters match: the request belongs to the model, not to fast-edit.
  const route = classifyRequest("đổi Ladder Width thành 450", { spec: spec() });
  assert.equal(route.tier, TIER.PATCH);
  assert.equal(route.fastEdit, undefined);

  // Formula parameter: same.
  assert.equal(classifyRequest("đổi Miter Offset thành 90", { spec: spec() }).tier, TIER.PATCH);
});

test("a complex request upgrades a flash model, staying on the same backend", () => {
  const cmdcIds = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-pro"];
  const tierModels = { 1: "cheap", 2: "codex:gpt-6-astra:medium", 3: "codex:gpt-6-astra:high" };

  assert.equal(
    strongerAvailableModel("deepseek/deepseek-v4.1-flash", tierModels, { cmdcModelIds: cmdcIds }),
    "deepseek/deepseek-v4-pro",
    "a cmdc model upgrades to a stronger cmdc model, not to codex",
  );
  assert.equal(
    strongerAvailableModel("codex:gpt-6-astra:low", tierModels),
    "codex:gpt-6-astra:medium",
  );
  assert.equal(strongerAvailableModel("deepseek/deepseek-v4-pro", tierModels), "deepseek/deepseek-v4-pro");
});

test("chooseTierModels honours env and the cheapest/medium/strongest defaults", () => {
  const models = chooseTierModels({
    env: {},
    cmdcModelIds: [
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4.1-flash-fast",
    ],
    backends: { codex: false },
  });
  assert.match(models[1], /flash/);
  assert.match(models[3], /pro/);

  const withCodex = chooseTierModels({ env: {}, cmdcModelIds: [], backends: { codex: true } });
  assert.equal(withCodex[1], "codex:gpt-6-astra:low");
  assert.equal(withCodex[2], "codex:gpt-6-astra:medium");
  assert.equal(withCodex[3], "codex:gpt-6-astra:high");

  const env = chooseTierModels({
    env: { AGENT_TIER1_MODEL: "cheap-x", AGENT_TIER2_MODEL: "mid-y", AGENT_TIER3_MODEL: "big-z" },
    cmdcModelIds: [],
    backends: {},
  });
  assert.deepEqual(env, { 1: "cheap-x", 2: "mid-y", 3: "big-z" });
});

test("a model picked by the user wins for tiers 1-2, tier 3 may upgrade", () => {
  const tierModels = { 1: "cheap", 2: "mid", 3: "big" };
  assert.equal(modelForTier(TIER.PATCH, { userModel: "mine", tierModels }), "mine");
  assert.equal(modelForTier(TIER.STRUCTURE, { userModel: "mine", tierModels }), "mine");
  assert.equal(modelForTier(TIER.REPAIR, { userModel: "mine", tierModels, allowUpgrade: true }), "big");
  assert.equal(modelForTier(TIER.REPAIR, { userModel: "mine", tierModels, allowUpgrade: false }), "mine");
});

test("patch prompt is small and carries only the relevant parts", () => {
  const summary = summarizeSpec(spec());
  assert.ok(summary.includes("Ladder Width 1"));
  assert.ok(summary.includes("Miter Offset"));
  assert.ok(!summary.includes('"schemaVersion"'));

  const context = affectedContext("đổi Ladder Width 1 thành 500", spec());
  assert.deepEqual(context.names, ["ladder width 1"]);

  const prompt = buildTierPrompt({
    tier: TIER.PATCH,
    request: "đổi Ladder Width 1 thành 500",
    spec: spec(),
    before: { x: 400, y: 300, z: 100 },
  });
  assert.ok(prompt.length < 4000);
  assert.ok(prompt.includes("Request: đổi Ladder Width 1 thành 500"));
  assert.ok(prompt.includes("Ladder Width 1"));
});

test("repair prompt carries the issues, not the whole spec", () => {
  const prompt = buildTierPrompt({
    tier: TIER.REPAIR,
    request: "fix",
    spec: spec(),
    issues: [{ path: "parts.body", message: "Part is outside the family bounds" }],
  });
  assert.ok(prompt.includes("parts.body: Part is outside the family bounds"));
  assert.ok(prompt.includes("Do not redesign anything else"));
  assert.ok(prompt.length < 5000);
});

test("limitPrompt truncates and reports it", () => {
  const limited = limitPrompt("x".repeat(200), 50);
  assert.equal(limited.truncated, true);
  assert.ok(limited.text.startsWith("x".repeat(50)));
  assert.equal(limitPrompt("short", 50).truncated, false);
});

test("cacheSignature ignores unrelated spec churn", () => {
  const a = cacheSignature({ normalizedRequest: "doi x", spec: spec(), model: "m", tier: 1 });
  const b = cacheSignature({
    normalizedRequest: "doi x",
    spec: { ...spec(), notes: ["unrelated"] },
    model: "m",
    tier: 1,
  });
  assert.deepEqual(a, b);

  const c = cacheSignature({ normalizedRequest: "doi y", spec: spec(), model: "m", tier: 1 });
  assert.notDeepEqual(a, c);
});

test("autoHeal fixes casing, missing params, materials and connector axes", () => {
  const healed = autoHealSpec({
    schemaVersion: "1.0",
    name: "Heal",
    category: "Generic Model",
    units: "mm",
    parameters: [
      { name: "Ladder Height", type: "Length", value: 100 },
      { name: "Offset", type: "Length", formula: "[ladder height] * 2 + [Missing Width]" },
    ],
    materials: [{ name: "Steel", color: "#888888" }],
    parts: [
      {
        id: "p1",
        name: "Body",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 400, y: 300, z: 100 } },
      },
      {
        id: "p2",
        name: "Stray",
        material: "NoSuchMaterial",
        solid: { kind: "box", origin: { x: 40000, y: 0, z: 0 }, size: { x: 10, y: 10, z: 10 } },
      },
    ],
    connectors: [
      { id: "c1", systemType: "CableTray", directionVector: { x: 0.7, y: 0.7, z: 0 } },
    ],
  });

  const offset = healed.parameters.find((param) => param.name === "Offset");
  assert.equal(offset.formula, "[Ladder Height] * 2 + [Missing Width]");
  assert.ok(healed.parameters.some((param) => param.name === "Missing Width"));

  // The palette gains an entry for the unknown material, and the part with no
  // material at all falls back to the first one.
  assert.equal(healed.parts[0].material, "Steel");
  assert.ok(healed.materials.some((material) => material.name === "NoSuchMaterial"));
  assert.equal(healed.parts[1].material, "NoSuchMaterial");
  assert.ok(healed.parts[1].solid.origin.x <= 400, "the stray part is pulled back inside");

  assert.deepEqual(healed.connectors[0].directionVector, { x: 1, y: 0, z: 0 });
  assert.ok(healed.notes.some((text) => text.includes("hướng connector")));
});
