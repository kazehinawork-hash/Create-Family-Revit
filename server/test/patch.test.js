import assert from "node:assert/strict";
import test from "node:test";

import {
  applySpecPatch,
  describeSpecPatch,
  isFullSpec,
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
