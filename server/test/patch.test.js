import assert from "node:assert/strict";
import test from "node:test";

import {
  applySpecPatch,
  describeSpecPatch,
  isFullSpec,
  isOverlappingRepairDuplicatePatch,
  isSpecPatch,
  mergeDeep,
} from "../src/patch.js";

const base = () => ({
  schemaVersion: "1.0",
  name: "Thang cáp 400",
  typeName: "Cable Ladder 400",
  category: "Electrical Equipment",
  units: "mm",
  parameters: [
    { name: "Ladder Width", type: "Length", group: "Dimensions", value: 400 },
    { name: "Rung Count", type: "Integer", group: "Dimensions", value: 6 },
  ],
  materials: [{ name: "Galvanized Steel", color: "#b9bec2" }],
  connectors: [{ id: "conn-a", name: "Đầu A", shape: "rectangular", width: 400, height: 100 }],
  parts: [
    {
      id: "rail-left",
      name: "Thanh bên trái",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 400, y: 15, z: 100 } },
    },
    {
      id: "rail-right",
      name: "Thanh bên phải",
      solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 400, y: 15, z: 100 } },
    },
  ],
  notes: ["Giả định: Rung Pitch = 300 mm."],
});

test("adding a part appends it", () => {
  const patch = {
    addParts: [{ id: "rung-1", name: "Bậc 1", solid: { kind: "box", size: { x: 370, y: 30, z: 5 } } }],
  };
  const out = applySpecPatch(base(), patch);

  assert.equal(out.parts.length, 3);
  assert.equal(out.parts[2].id, "rung-1");
});

test("the same id updates the part instead of duplicating it", () => {
  const patch = {
    addParts: [{ id: "rail-left", name: "Thanh trái mới", solid: { size: { x: 500 } } }],
  };
  const out = applySpecPatch(base(), patch);

  assert.equal(out.parts.length, 2);
  const rail = out.parts.find((part) => part.id === "rail-left");
  assert.equal(rail.name, "Thanh trái mới");
  assert.equal(rail.solid.size.x, 500);
  // Deep merge keeps the other size axes.
  assert.equal(rail.solid.size.y, 15);
});

test("updateParts patches existing parts by id", () => {
  const out = applySpecPatch(base(), {
    updateParts: [{ id: "rail-right", material: "Steel" }],
  });

  assert.equal(out.parts.find((part) => part.id === "rail-right").material, "Steel");
  assert.equal(out.parts.length, 2);
});

test("removePartIds deletes parts", () => {
  const out = applySpecPatch(base(), { removePartIds: ["rail-right"] });

  assert.deepEqual(out.parts.map((part) => part.id), ["rail-left"]);
});

test("parameters, connectors and materials are merged by id/name", () => {
  const out = applySpecPatch(base(), {
    updateParameters: [{ name: "Rung Count", value: 8 }],
    addParameters: [{ name: "Rung Pitch", type: "Length", group: "Dimensions", value: 300 }],
    updateConnectors: [{ id: "conn-a", width: 450 }],
    addConnectors: [{ id: "conn-b", name: "Đầu B", shape: "rectangular" }],
    materials: [{ name: "Galvanized Steel", metalness: 0.4 }, { name: "Rubber", color: "#222222" }],
  });

  assert.equal(out.parameters.length, 3);
  assert.equal(out.parameters.find((p) => p.name === "Rung Count").value, 8);
  assert.equal(out.parameters.find((p) => p.name === "Rung Count").type, "Integer");
  assert.equal(out.connectors.length, 2);
  assert.equal(out.connectors[0].width, 450);
  assert.equal(out.connectors[0].name, "Đầu A");
  assert.equal(out.materials.length, 2);
  assert.equal(out.materials.find((m) => m.name === "Galvanized Steel").color, "#b9bec2");
});

test("an empty patch leaves the spec unchanged", () => {
  const spec = base();
  assert.deepEqual(applySpecPatch(spec, {}), spec);
  assert.deepEqual(applySpecPatch(spec, { addParts: [] }), spec);
  assert.deepEqual(applySpecPatch(spec, { note: "ignored" }), spec);
});

test("the base spec is never mutated", () => {
  const spec = base();
  const snapshot = JSON.stringify(spec);

  applySpecPatch(spec, {
    addParts: [{ id: "rung-1", name: "Bậc 1", solid: { kind: "box" } }],
    removePartIds: ["rail-left"],
  });

  assert.equal(JSON.stringify(spec), snapshot);
});

test("a complete spec is accepted as the patch result", () => {
  const full = { ...base(), name: "Family mới" };

  assert.equal(isFullSpec(full), true);
  assert.equal(applySpecPatch(base(), full), full);
});

test("a full-spec-shaped patch is never merged field by field", () => {
  const full = { schemaVersion: "1.0", name: "X", parts: [] };
  assert.deepEqual(applySpecPatch(base(), full), full);
});

test("patch detection and summary", () => {
  assert.equal(isSpecPatch({ addParts: [] }), true);
  assert.equal(isSpecPatch({ hello: "world" }), false);
  assert.match(describeSpecPatch({ addParts: [{ id: "a" }, { id: "b" }], removePartIds: ["c"] }), /\+2 parts, -1 parts/);
});

test("mergeDeep keeps untouched nested fields", () => {
  assert.deepEqual(
    mergeDeep({ a: 1, nested: { b: 2, c: 3 } }, { nested: { c: 9 } }),
    { a: 1, nested: { b: 2, c: 9 } },
  );
});

test("macro patches update, add and remove macros cleanly", () => {
  const withMacro = {
    ...base(),
    macros: [{ kind: "trayRun", id: "run-1", width: 400, height: 100, thickness: 1.5, segments: [{ kind: "straight", length: 500 }] }],
  };

  assert.equal(isSpecPatch({ updateMacros: [] }), true);
  assert.equal(isSpecPatch({ macros: [] }), true);

  const updated = applySpecPatch(withMacro, {
    updateMacros: [{ id: "run-1", width: 600 }],
    addMacros: [{ kind: "trayRun", id: "run-2", width: 300, height: 100, thickness: 1.5, segments: [{ kind: "straight", length: 400 }] }],
  });
  assert.equal(updated.macros.length, 2);
  assert.equal(updated.macros[0].width, 600);

  const removed = applySpecPatch(updated, { removeMacroIds: ["run-1"] });
  assert.deepEqual(removed.macros.map((m) => m.id), ["run-2"]);
});

test("repair patch keeps existing parts when adding genuine new parts (5 parts + 4 bolts -> 9 parts)", () => {
  const assembly = {
    ...base(),
    parts: [
      { id: "a", name: "Base Plate", solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 400, y: 300, z: 12 } } },
      { id: "b", name: "Housing", solid: { kind: "box", origin: { x: 0, y: 0, z: 12 }, size: { x: 260, y: 200, z: 140 } } },
      { id: "c", name: "Cover", solid: { kind: "box", origin: { x: 0, y: 0, z: 152 }, size: { x: 260, y: 200, z: 10 } } },
      { id: "d", name: "Inlet Collar", solid: { kind: "cylinder", axis: "x", base: { x: -160, y: 0, z: 80 }, radius: 40, height: 30 } },
      { id: "e", name: "Outlet Collar", solid: { kind: "cylinder", axis: "x", base: { x: 130, y: 0, z: 80 }, radius: 40, height: 30 } },
    ],
  };

  const addBoltsPatch = {
    addParts: [
      { id: "bolt-1", name: "Bolt FL", solid: { kind: "cylinder", axis: "z", base: { x: -170, y: -120, z: 12 }, radius: 6, height: 20 } },
      { id: "bolt-2", name: "Bolt FR", solid: { kind: "cylinder", axis: "z", base: { x: 170, y: -120, z: 12 }, radius: 6, height: 20 } },
      { id: "bolt-3", name: "Bolt RL", solid: { kind: "cylinder", axis: "z", base: { x: -170, y: 120, z: 12 }, radius: 6, height: 20 } },
      { id: "bolt-4", name: "Bolt RR", solid: { kind: "cylinder", axis: "z", base: { x: 170, y: 120, z: 12 }, radius: 6, height: 20 } },
    ],
  };

  assert.equal(isOverlappingRepairDuplicatePatch(assembly, addBoltsPatch), false);
  const patched = applySpecPatch(assembly, addBoltsPatch, { mode: "repair" });
  assert.equal(patched.parts.length, 9);
  assert.deepEqual(
    patched.parts.map((part) => part.id),
    ["a", "b", "c", "d", "e", "bolt-1", "bolt-2", "bolt-3", "bolt-4"],
  );
});

test("repair patch deduplicates exact-geometry / unique-name copies and flags overlapping rebuilds", () => {
  const gauge = {
    ...base(),
    parts: [
      { id: "than-dong-ho", name: "Thân đồng hồ", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: 0, z: 60 }, radius: 50, height: 30 } },
      { id: "mat-kinh", name: "Mặt kính", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: -2, z: 60 }, radius: 46, height: 3 } },
      { id: "kim-chi-thi", name: "Kim chỉ thị", solid: { kind: "box", origin: { x: 0, y: -1, z: 60 }, size: { x: 35, y: 2, z: 2 } } },
      { id: "chan-ren", name: "Chân ren", solid: { kind: "cylinder", axis: "z", base: { x: 0, y: 17, z: 0 }, radius: 10, height: 25 } },
    ],
  };

  const englishExactClonePatch = {
    addParts: [
      { id: "gauge-body", name: "Gauge Body", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: 0, z: 60 }, radius: 50, height: 30 } },
      { id: "dial-glass", name: "Dial Glass", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: -2, z: 60 }, radius: 46, height: 3 } },
      { id: "pointer", name: "Pointer", solid: { kind: "box", origin: { x: 0, y: -1, z: 60 }, size: { x: 35, y: 2, z: 2 } } },
      { id: "process-stem", name: "Process Stem", solid: { kind: "cylinder", axis: "z", base: { x: 0, y: 17, z: 0 }, radius: 10, height: 25 } },
    ],
  };

  // Exact geometry match in repair mode replaces in place instead of doubling.
  const repaired = applySpecPatch(gauge, englishExactClonePatch, { mode: "repair" });
  assert.equal(repaired.parts.length, 4);
  assert.deepEqual(
    repaired.parts.map((part) => part.id),
    ["gauge-body", "dial-glass", "pointer", "process-stem"],
  );

  // Overlapping parallel rebuild with tweaked dimensions is flagged as a duplicate patch.
  const englishModifiedOverlapPatch = {
    addParts: [
      { id: "gauge-body", name: "Gauge Body", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: 0, z: 60 }, radius: 52, height: 32 } },
      { id: "dial-glass", name: "Dial Glass", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: -2, z: 60 }, radius: 47, height: 3 } },
      { id: "pointer", name: "Pointer", solid: { kind: "box", origin: { x: 0, y: -1, z: 60 }, size: { x: 36, y: 2, z: 2 } } },
      { id: "process-stem", name: "Process Stem", solid: { kind: "cylinder", axis: "z", base: { x: 0, y: 17, z: 0 }, radius: 11, height: 26 } },
    ],
  };
  assert.equal(isOverlappingRepairDuplicatePatch(gauge, englishModifiedOverlapPatch), true);

  // Uncertain individual matches in applySpecPatch never delete original base parts.
  const uncertainMerged = applySpecPatch(gauge, englishModifiedOverlapPatch, { mode: "repair" });
  assert.equal(uncertainMerged.parts.length, 8);

  // Repair patch with same unique name under a new id updates in place instead of duplicating.
  const renamedIdSameName = applySpecPatch(
    gauge,
    {
      addParts: [
        { id: "gauge-body", name: "Thân đồng hồ", solid: { kind: "cylinder", axis: "y", base: { x: 0, y: 0, z: 60 }, radius: 55, height: 30 } },
      ],
    },
    { mode: "repair" },
  );
  assert.equal(renamedIdSameName.parts.length, 4);
  assert.equal(renamedIdSameName.parts[0].solid.radius, 55);

  // Section builds still append all new parts when mode is "section".
  const sectioned = applySpecPatch(gauge, englishExactClonePatch, { mode: "section" });
  assert.equal(sectioned.parts.length, 8);
});
