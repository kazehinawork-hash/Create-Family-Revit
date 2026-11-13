// These tests cover the opt-in pipeline (templates, evidence, tiers, split steps).
process.env.AGENT_EXPERIMENTAL_PIPELINE = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";
import { resolveRuleValues } from "../src/rules.js";
import { snapshotRulesTree, withRulesDir } from "./helpers/rules-dir.js";

beforeEach(() => clearCachedResults());

function material(name = "Steel") {
  return { name, color: "#8a9ba8", metalness: 0.6, roughness: 0.4 };
}

function valveSpec({ badHole = false, inwardConnector = false, name = "Butterfly Valve DN150" } = {}) {
  const parts = [
    {
      id: "body",
      name: "Valve Body",
      material: "Steel",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 110 }, size: { x: 220, y: 285, z: 220 } },
    },
    {
      id: "flange-1",
      name: "Flange Inlet",
      material: "Steel",
      solid: { kind: "box", origin: { x: -130, y: 0, z: 110 }, size: { x: 40, y: 285, z: 285 } },
    },
    {
      id: "flange-2",
      name: "Flange Outlet",
      material: "Steel",
      solid: { kind: "box", origin: { x: 130, y: 0, z: 110 }, size: { x: 40, y: 285, z: 285 } },
    },
    {
      id: "disc",
      name: "Disc",
      material: "Steel",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 110 }, size: { x: 12, y: 150, z: 150 } },
    },
    {
      id: "stem",
      name: "Stem",
      material: "Steel",
      solid: { kind: "cylinder", axis: "z", base: { x: 0, y: 0, z: 220 }, radius: 20, height: 120 },
    },
    {
      id: "handle",
      name: "Handle",
      material: "Steel",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 340 }, size: { x: 240, y: 40, z: 20 } },
    },
  ];

  if (badHole) {
    // A hole 2 mm from the flange edge is impossible to machine.
    parts[1].cuts = [
      {
        kind: "box",
        origin: { x: -130, y: 120, z: 110 },
        size: { x: 30, y: 20, z: 20 },
      },
    ];
  }

  const connectors = [
    {
      id: "inlet",
      name: "Inlet",
      systemType: "Pipe",
      shape: "round",
      origin: { x: inwardConnector ? 130 : -150, y: 0, z: 110 },
      directionVector: { x: inwardConnector ? -1 : -1, y: 0, z: 0 },
      diameter: 150,
    },
  ];

  return {
    schemaVersion: "1.0",
    name,
    category: "Pipe Fitting",
    units: "mm",
    parameters: [
      { name: "Nominal Size", type: "Length", group: "Dimensions", value: 150 },
      { name: "Body Length", type: "Length", group: "Dimensions", value: 220 },
    ],
    materials: [material()],
    parts,
    connectors,
    notes: [],
  };
}

function fanSpec() {
  return {
    schemaVersion: "1.0",
    name: "Axial Fan 500",
    category: "Mechanical Equipment",
    units: "mm",
    parameters: [
      { name: "Impeller Diameter", type: "Length", group: "Dimensions", value: 500 },
      { name: "Motor Power", type: "Number", group: "Data", value: 1.5 },
    ],
    materials: [material()],
    parts: [
      { id: "casing", name: "Fan Casing", material: "Steel", solid: { kind: "cylinder", axis: "x", base: { x: 0, y: 0, z: 0 }, radius: 280, height: 220 } },
      { id: "impeller", name: "Impeller", material: "Steel", solid: { kind: "cylinder", axis: "x", base: { x: 60, y: 0, z: 250 }, radius: 250, height: 100 } },
      ...[1, 2, 3, 4, 5, 6].map((index) => ({
        id: `blade-${index}`,
        name: `Blade ${index}`,
        material: "Steel",
        solid: {
          kind: "box",
          origin: { x: 110, y: Math.cos((index * Math.PI) / 3) * 100, z: 250 + Math.sin((index * Math.PI) / 3) * 100 },
          size: { x: 60, y: 20, z: 200 },
        },
      })),
      { id: "motor", name: "Motor", material: "Steel", solid: { kind: "cylinder", axis: "x", base: { x: 160, y: 0, z: 250 }, radius: 60, height: 180 } },
    ],
    connectors: [
      { id: "outlet", name: "Outlet", systemType: "Duct", shape: "round", origin: { x: 220, y: 0, z: 250 }, directionVector: { x: 1, y: 0, z: 0 }, diameter: 500 },
    ],
    notes: [],
  };
}

function panelSpec() {
  return {
    schemaVersion: "1.0",
    name: "Electrical Panel",
    category: "Electrical Equipment",
    units: "mm",
    parameters: [{ name: "Panel Width", type: "Length", group: "Dimensions", value: 800 }],
    materials: [material()],
    parts: [
      { id: "enclosure", name: "Enclosure", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 600 }, size: { x: 800, y: 300, z: 1200 } } },
      { id: "door-1", name: "Door 1", material: "Steel", solid: { kind: "box", origin: { x: -200, y: -160, z: 600 }, size: { x: 390, y: 20, z: 1150 } } },
      { id: "door-2", name: "Door 2", material: "Steel", solid: { kind: "box", origin: { x: 200, y: -160, z: 600 }, size: { x: 390, y: 20, z: 1150 } } },
      { id: "din-rail-1", name: "DIN Rail 1", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 900 }, size: { x: 640, y: 35, z: 7.5 } } },
      { id: "din-rail-2", name: "DIN Rail 2", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 700 }, size: { x: 640, y: 35, z: 7.5 } } },
      { id: "gland-plate", name: "Gland Plate", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 6 }, size: { x: 680, y: 200, z: 12 } } },
      { id: "gland-1", name: "Cable Gland 1", material: "Steel", solid: { kind: "cylinder", axis: "z", base: { x: -200, y: 0, z: 0 }, radius: 10, height: 10 } },
      { id: "gland-2", name: "Cable Gland 2", material: "Steel", solid: { kind: "cylinder", axis: "z", base: { x: -100, y: 0, z: 0 }, radius: 10, height: 10 } },
      { id: "gland-3", name: "Cable Gland 3", material: "Steel", solid: { kind: "cylinder", axis: "z", base: { x: 100, y: 0, z: 0 }, radius: 10, height: 10 } },
      { id: "gland-4", name: "Cable Gland 4", material: "Steel", solid: { kind: "cylinder", axis: "z", base: { x: 200, y: 0, z: 0 }, radius: 10, height: 10 } },
    ],
    connectors: [],
    notes: [],
  };
}

/** Distinguishes vision / rule-learning / spec calls and records them. */
function mockAgent({ evidence = null, rule = null, spec, onSpec = null }) {
  const calls = { vision: 0, learn: 0, spec: 0, prompts: [] };

  const generate = async (messages) => {
    const system = String(messages?.[0]?.content ?? "");
    const last = messages[messages.length - 1];
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);

    if (system.includes("mechanical engineer reading product photos")) {
      calls.vision += 1;
      return { json: evidence, text: "", usage: null };
    }
    if (system.includes("Propose a reusable rule pack")) {
      calls.learn += 1;
      return { json: rule, text: "", usage: null };
    }

    calls.spec += 1;
    calls.prompts.push(text);
    const nextSpec = typeof spec === "function" ? spec(calls.spec) : spec;
    if (onSpec) onSpec(calls.spec);
    return { json: nextSpec, text: "", usage: null };
  };

  return { generate, calls };
}

test("(a) a DN150 PN16 butterfly valve gets EN 1092-1 flange data and a complete spec", async () => {
  const { generate, calls } = mockAgent({
    rule: { productType: "valve", parameters: [], components: [], connectors: [], materials: [], matchers: { keywords: [] } },
    spec: valveSpec(),
  });

  const result = await design({
    prompt: "van bướm DN150 PN16",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate,
  });

  assert.equal(calls.learn, 0, "a known product type must not learn a new pack");
  assert.equal(result.stats.productType, "valve");

  const byName = Object.fromEntries(result.stats.resolution.map((entry) => [entry.name, entry]));
  assert.equal(byName["Flange PCD"].value, 240);
  assert.equal(byName["Flange Bolts"].value, 8);
  assert.match(byName["Flange PCD"].source, /EN 1092-1 PN16/);
  assert.equal(byName["Flange OD"].value, 285);
  assert.equal(byName["Nominal Size"].value, 150);

  // Flange data is in the prompt the geometry model receives.
  assert.match(calls.prompts[0], /Flange PCD = 240/);
  assert.match(calls.prompts[0], /8×M20|8 .*M20/);

  assert.equal(result.stats.complete, true, JSON.stringify(result.stats.missing));
  assert.ok(
    !(result.analysis.spec.notes ?? []).some((note) => /\?$/.test(note)),
    "the spec must not end with a question",
  );
});

test("(b) an axial fan derives the IEC motor frame from the power", async () => {
  const { generate } = mockAgent({ spec: fanSpec() });

  const result = await design({
    prompt: "quạt hướng trục Ø500, motor 1.5 kW",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate,
  });

  const byName = Object.fromEntries(result.stats.resolution.map((entry) => [entry.name, entry]));
  assert.equal(byName["Motor Frame Size"].value, "90L");
  assert.equal(byName["Motor Shaft Height"].value, 90);
  assert.equal(byName["Impeller Diameter"].value, 500);

  assert.equal(result.stats.productType, "fan");
  assert.equal(result.stats.complete, true, JSON.stringify(result.stats.missing));
});

test("(c) a photo is read by the vision model and level-3 sizes follow the 800 mm scale", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "family-photo-"));
  const photo = path.join(temp, "panel.png");
  fs.writeFileSync(photo, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

  const evidence = {
    productType: "electrical-panel",
    category: "Electrical Equipment",
    overall: { x: 800, y: 300, z: 1200 },
    dimensions: [
      { name: "Panel Width", value: 0, unit: "mm", level: 3, source: "Đo theo tỷ lệ", pixels: 1000, scaleRef: "photo" },
      { name: "Panel Height", value: 1200, unit: "mm", level: 1, source: "Catalog" },
    ],
    scaleRefs: [{ what: "overall width", knownMm: 800, pixels: 1000, image: "photo" }],
    components: [
      { kind: "door", count: 2 },
      { kind: "cable-gland", count: 4 },
    ],
    materials: [{ name: "Powder Coated Steel", color: "#d7d7d7", finish: "RAL 7035", level: 1 }],
    connectors: [],
  };

  const { generate, calls } = mockAgent({ evidence, spec: panelSpec() });

  const result = await design({
    prompt: "tủ điện theo ảnh, chiều rộng thực tế 800 mm",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "gpt-4o",
    attachments: [{ path: photo, name: "panel.png" }],
    generate,
  });

  assert.equal(calls.vision, 1, "the image must go through the vision model");

  const byName = Object.fromEntries(result.stats.resolution.map((entry) => [entry.name, entry]));
  assert.equal(byName["Panel Width"].value, 800, "pixels × mm/px");
  assert.equal(byName["Panel Width"].level, 3);

  const groups = Object.fromEntries(
    (result.stats.checklist?.groups ?? []).map((group) => [group.role, group.expected]),
  );
  assert.equal(groups.door, 2);
  assert.equal(groups["cable-gland"], 4);
  assert.equal(result.stats.complete, true, JSON.stringify(result.stats.missing));

  fs.rmSync(temp, { recursive: true, force: true });
});

test("(d) a product code sets width/height/thickness at level 1", async () => {
  const { generate } = mockAgent({ spec: cableSpec() });

  const result = await design({
    prompt: "thang cáp TP-LC-400x100-1.5",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate,
  });

  const byName = Object.fromEntries(result.stats.resolution.map((entry) => [entry.name, entry]));
  assert.equal(byName["Ladder Width 1"].value, 400);
  assert.equal(byName["Ladder Height"].value, 100);
  assert.equal(byName["Sheet Thickness"].value, 1.5);
  assert.equal(byName["Ladder Width 1"].level, 1);
  assert.match(byName["Ladder Width 1"].source, /Mã sản phẩm/);
  assert.equal(result.stats.productType, "cable-ladder");
});

test("(e) an unknown product type is learned once and reused", async () => {
  await withRulesDir(async (dir) => {
    const learned = {
      productType: "grease-trap",
      aliases: ["bẫy mỡ"],
      category: "Specialty Equipment",
      matchers: { keywords: ["bẫy mỡ", "grease trap"], codePatterns: [] },
      parameters: [
        { name: "Trap Length", group: "Dimensions", unit: "mm", default: 600, range: [300, 2000] },
        { name: "Trap Width", group: "Dimensions", unit: "mm", default: 400, range: [200, 1200] },
      ],
      components: [{ kind: "body", required: true, countFormula: "1" }],
      connectors: [],
      materials: [{ name: "Stainless Steel", color: "#c0c0c0", finish: "brushed" }],
      checks: [],
    };

    const trapSpec = {
      schemaVersion: "1.0",
      name: "Grease Trap",
      category: "Specialty Equipment",
      units: "mm",
      parameters: [
        { name: "Trap Length", type: "Length", group: "Dimensions", value: 600 },
        { name: "Trap Width", type: "Length", group: "Dimensions", value: 400 },
      ],
      materials: [material("Stainless Steel")],
      parts: [
        { id: "body", name: "Body", material: "Stainless Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 200 }, size: { x: 600, y: 400, z: 400 } } },
      ],
      connectors: [],
      notes: [],
    };

    const first = mockAgent({ rule: learned, spec: trapSpec });
    const one = await design({
      prompt: "bẫy mỡ inox cho bếp công nghiệp",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: first.generate,
      learnRules: true,
    });

    assert.equal(first.calls.learn, 1);
    assert.equal(one.stats.ruleSource, "learned-new");
    assert.ok(fs.existsSync(path.join(dir, "learned", "grease-trap.json")));

    const second = mockAgent({ spec: trapSpec });
    clearCachedResults();
    const two = await design({
      prompt: "bẫy mỡ inox loại lớn cho bếp công nghiệp",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: second.generate,
    });

    assert.equal(second.calls.learn, 0, "the learned pack must be reused");
    assert.equal(two.stats.ruleSource, "learned");
  });
});

test("(f) a low-level value never overrides a higher-level one", () => {
  const rule = {
    productType: "valve",
    parameters: [
      { name: "Nominal Size", group: "Dimensions", unit: "mm", default: 50 },
      { name: "Disc Thickness", group: "Dimensions", unit: "mm", formula: "[Nominal Size] * 0.06 + 4" },
    ],
  };

  const evidence = {
    dimensions: [
      { name: "Nominal Size", value: 150, unit: "mm", level: 1, source: "Catalog" },
      { name: "Nominal Size", value: 300, unit: "mm", level: 5, source: "Giả định" },
    ],
  };

  const resolved = resolveRuleValues(rule, { evidence, overrides: {} });
  const nominal = resolved.find((entry) => entry.name === "Nominal Size");
  assert.equal(nominal.value, 150);
  assert.equal(nominal.level, 1);
});

test("(g) an implausible hole and an inward connector trigger one repair turn", async () => {
  const { generate, calls } = mockAgent({
    spec: (index) => (index === 1 ? valveSpec({ badHole: true, inwardConnector: true }) : valveSpec()),
  });

  const result = await design({
    prompt: "van bướm DN150 PN16",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    generate,
  });

  assert.equal(calls.spec, 2, "one build + one self-repair");
  assert.match(calls.prompts[1], /cách mép|quay vào trong/);
  assert.equal(result.stats.complete, true, JSON.stringify(result.stats.missing));
});

test("(h) only detail values are remembered; brief sizes always win", async () => {
  await withRulesDir(async () => {
    // 1. Rung Pitch is a detail (remember: true) -> remembered.
    const pitchSpec = { ...cableSpec() };
    pitchSpec.parameters = [
      ...pitchSpec.parameters,
      { name: "Rung Pitch", type: "Length", group: "Dimensions", value: 300 },
    ];

    const first = mockAgent({ spec: cableSpec() });
    await design({
      prompt: "đổi Rung Pitch thành 350",
      currentSpec: pitchSpec,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: first.generate,
    });

    const second = mockAgent({ spec: cableSpec() });
    const result = await design({
      prompt: "tạo ngã tư thang cáp 400x100",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: second.generate,
    });

    const byName = Object.fromEntries(result.stats.resolution.map((entry) => [entry.name, entry]));
    assert.equal(byName["Rung Pitch"].value, 350, "the remembered detail value is used");
    assert.match(byName["Rung Pitch"].source, /Theo lựa chọn trước/);

    // 2. Nominal Size is a key size (remember: false) -> never remembered, DN150 wins.
    const valve = valveSpec();
    const third = mockAgent({ spec: valve });
    await design({
      prompt: "đổi Nominal Size thành 250",
      currentSpec: valve,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: third.generate,
    });

    const fourth = mockAgent({ spec: valve });
    const valveRun = await design({
      prompt: "van bướm DN150 PN16",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: fourth.generate,
    });

    const valveValues = Object.fromEntries(
      valveRun.stats.resolution.map((entry) => [entry.name, entry]),
    );
    assert.equal(valveValues["Nominal Size"].value, 150);
    assert.equal(valveValues["Nominal Size"].level, 1);
  });
});

test("a design run never writes into the repository rules tree", async () => {
  const before = snapshotRulesTree();

  await withRulesDir(async () => {
    const { generate } = mockAgent({ spec: valveSpec() });
    await design({
      prompt: "van bướm DN150 PN16",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate,
    });
  });

  assert.deepEqual(snapshotRulesTree(), before);
});

test("(i) without a vision model the run warns and still returns a spec", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "family-photo-"));
  const photo = path.join(temp, "fan.png");
  fs.writeFileSync(photo, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

  const { generate, calls } = mockAgent({ spec: fanSpec() });

  const result = await design({
    prompt: "quạt hướng trục theo ảnh",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    attachments: [{ path: photo, name: "fan.png" }],
    generate,
  });

  assert.equal(calls.vision, 0);
  assert.ok(
    result.stats.warnings.some((warning) => /vision/i.test(warning)),
    "the missing vision model is reported",
  );
  assert.ok(result.analysis.spec.parts.length > 0);

  fs.rmSync(temp, { recursive: true, force: true });
});

function cableSpec() {
  return {
    schemaVersion: "1.0",
    name: "Cable Ladder Cross",
    category: "Electrical Equipment",
    units: "mm",
    parameters: [
      { name: "Ladder Width 1", type: "Length", group: "Dimensions", value: 400 },
      { name: "Ladder Height", type: "Length", group: "Dimensions", value: 100 },
      { name: "Sheet Thickness", type: "Length", group: "Dimensions", value: 1.5 },
    ],
    materials: [material()],
    parts: [
      { id: "corner-1", name: "Corner Rail 1 Web", material: "Steel", solid: { kind: "box", origin: { x: -300, y: -300, z: 50 }, size: { x: 20, y: 20, z: 100 } } },
      { id: "corner-2", name: "Corner Rail 2 Web", material: "Steel", solid: { kind: "box", origin: { x: 300, y: -300, z: 50 }, size: { x: 20, y: 20, z: 100 } } },
      { id: "corner-3", name: "Corner Rail 3 Web", material: "Steel", solid: { kind: "box", origin: { x: -300, y: 300, z: 50 }, size: { x: 20, y: 20, z: 100 } } },
      { id: "corner-4", name: "Corner Rail 4 Web", material: "Steel", solid: { kind: "box", origin: { x: 300, y: 300, z: 50 }, size: { x: 20, y: 20, z: 100 } } },
      { id: "rung-1", name: "Rung 1", material: "Steel", solid: { kind: "box", origin: { x: -100, y: 0, z: 50 }, size: { x: 35, y: 400, z: 15 } } },
      { id: "rung-2", name: "Rung 2", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 50 }, size: { x: 35, y: 400, z: 15 } } },
      { id: "rung-3", name: "Rung 3", material: "Steel", solid: { kind: "box", origin: { x: 100, y: 0, z: 50 }, size: { x: 35, y: 400, z: 15 } } },
      { id: "rung-4", name: "Rung 4", material: "Steel", solid: { kind: "box", origin: { x: -100, y: 0, z: 50 }, size: { x: 35, y: 400, z: 15 } } },
      { id: "rung-5", name: "Rung 5", material: "Steel", solid: { kind: "box", origin: { x: 0, y: 0, z: 50 }, size: { x: 35, y: 400, z: 15 } } },
      { id: "rung-6", name: "Rung 6", material: "Steel", solid: { kind: "box", origin: { x: 100, y: 0, z: 50 }, size: { x: 35, y: 400, z: 15 } } },
    ],
    connectors: [
      { id: "main-in", name: "Main In", systemType: "CableTray", shape: "rectangular", origin: { x: -400, y: 0, z: 50 }, directionVector: { x: -1, y: 0, z: 0 }, width: 400, height: 100 },
      { id: "main-out", name: "Main Out", systemType: "CableTray", shape: "rectangular", origin: { x: 400, y: 0, z: 50 }, directionVector: { x: 1, y: 0, z: 0 }, width: 400, height: 100 },
      { id: "branch-in", name: "Branch In", systemType: "CableTray", shape: "rectangular", origin: { x: 0, y: -400, z: 50 }, directionVector: { x: 0, y: -1, z: 0 }, width: 400, height: 100 },
      { id: "branch-out", name: "Branch Out", systemType: "CableTray", shape: "rectangular", origin: { x: 0, y: 400, z: 50 }, directionVector: { x: 0, y: 1, z: 0 }, width: 400, height: 100 },
    ],
    notes: [],
  };
}
