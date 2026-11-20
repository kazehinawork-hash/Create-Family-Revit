import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOD, LOD_LEVELS, lodStandard } from "../src/designer.js";

test("offers LOD 200, 300, 350 and 400 with 300 as the default", () => {
  assert.deepEqual(LOD_LEVELS, [200, 300, 350, 400]);
  assert.equal(DEFAULT_LOD, 300);
});

test("every level names itself and its part budget", () => {
  for (const level of LOD_LEVELS) {
    const text = lodStandard(level);
    assert.match(text, new RegExp(`LOD ${level}`));
    assert.match(text, /parts/);
    assert.match(text, new RegExp(`Mức LOD ${level} đã nằm trong trường`));
  }
});

test("LOD 350 is the coordination level, not fabrication", () => {
  const text = lodStandard(350);
  assert.match(text, /coordination/i);
  assert.match(text, /tai treo/);
  assert.match(text, /bích/);
  assert.match(text, /Không/);
});

test("unknown levels fall back to the default", () => {
  assert.equal(lodStandard(250), lodStandard(DEFAULT_LOD));
  assert.equal(lodStandard("nonsense"), lodStandard(DEFAULT_LOD));
  assert.equal(lodStandard(undefined), lodStandard(DEFAULT_LOD));
});
