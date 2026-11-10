import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpec } from "@family/spec-core";
import { auditBuild } from "../src/build-qa.js";

const spec = {
  schemaVersion: "1.0",
  name: "Box",
  category: "Generic Model",
  units: "mm",
  parameters: [],
  materials: [],
  parts: [
    {
      id: "box",
      name: "Box",
      solid: {
        kind: "box",
        origin: { x: 0, y: 0, z: 0 },
        size: { x: 100, y: 100, z: 100 },
      },
    },
  ],
};

const analysis = analyzeSpec(spec);

test("passes when the build stats match the resolved model", () => {
  const qa = auditBuild(analysis, {
    ok: true,
    stats: {
      parts: 1,
      instances: 1,
      connectors: 0,
      parameters: 0,
      bounds: { x: 100, y: 100, z: 100 },
    },
  });

  assert.equal(qa.ok, true);
  assert.deepEqual(qa.warnings, []);
  assert.equal(qa.rebuildRequired, false);
});

test("reports a missing part and a parameter count mismatch", () => {
  const qa = auditBuild(analysis, {
    ok: true,
    stats: {
      parts: 0,
      instances: 1,
      connectors: 0,
      parameters: 3,
      bounds: { x: 100, y: 100, z: 100 },
    },
  });

  assert.equal(qa.ok, false);
  assert.ok(qa.warnings.some((warning) => warning.includes("0/1 part")));
  assert.ok(qa.warnings.some((warning) => warning.includes("3/0 parameter")));
});

test("flags missing forms and lists the failed parts", () => {
  const qa = auditBuild(analysis, {
    ok: true,
    stats: {
      parts: 1,
      instances: 1,
      totalForms: 0,
      missingForms: 1,
      failedParts: ["box: produced no solid"],
      connectors: 0,
      parameters: 0,
      bounds: { x: 100, y: 100, z: 100 },
    },
  });

  assert.equal(qa.ok, false);
  assert.ok(qa.warnings.some((warning) => warning.includes("0 form")));
  assert.ok(qa.warnings.some((warning) => warning.includes("1 part/copy")));
  assert.ok(qa.warnings.some((warning) => warning.includes("produced no solid")));
});

test("flags FreeFormElement output as needing a rebuild", () => {
  const qa = auditBuild(analysis, {
    ok: true,
    stats: {
      parts: 1,
      instances: 1,
      connectors: 0,
      parameters: 0,
      bounds: { x: 100, y: 100, z: 100 },
      freeforms: 1,
    },
  });

  assert.equal(qa.ok, false);
  assert.equal(qa.rebuildRequired, true);
  assert.ok(qa.warnings.some((warning) => warning.includes("FreeFormElement")));
});

test("reports a bounding-box mismatch", () => {
  const qa = auditBuild(analysis, {
    ok: true,
    stats: {
      parts: 1,
      instances: 1,
      connectors: 0,
      parameters: 0,
      bounds: { x: 140, y: 100, z: 100 },
    },
  });

  assert.equal(qa.ok, false);
  assert.ok(qa.warnings.some((warning) => warning.includes("kích thước bao lệch")));
});
