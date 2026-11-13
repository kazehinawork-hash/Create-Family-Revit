import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { config } from "../src/config.js";
import { findClosestSample, scoreSample, tokenize } from "../src/samples.js";

const TEE_FILE = path.join(
  config.dirs.saved,
  "1794390236816-thinh-phat-cable-ladder-mitered-tee.json",
);

function teeEntry() {
  const data = JSON.parse(fs.readFileSync(TEE_FILE, "utf8"));
  return { id: data.id ?? path.basename(TEE_FILE, ".json"), name: data.spec?.name ?? "tee", spec: data.spec ?? data };
}

test("tokenize drops stopwords and diacritics", () => {
  const tokens = tokenize("Tạo một family tee thang cáp cho công trình");
  assert.ok(tokens.has("tee"));
  assert.ok(tokens.has("thang"));
  assert.ok(!tokens.has("cho"));
});

test("the saved mitered tee scores high for a tee request", () => {
  const entry = teeEntry();
  const good = scoreSample("tạo tee thang cáp 400x300 có nhánh xiên", entry);
  const bad = scoreSample("tạo bồn nước inox 2000 lít", entry);

  assert.ok(good > bad);
  assert.ok(good >= 0.3, `expected a decent score, got ${good}`);
});

test("findClosestSample returns the tee, and nothing for an unrelated request", () => {
  const match = findClosestSample("làm tee thang cáp có nhánh 400x300");
  assert.ok(match, "a tee request should match the saved tee");
  assert.equal(match.id, teeEntry().id);

  assert.equal(findClosestSample("tạo bồn nước inox 2000 lít"), null);
});
