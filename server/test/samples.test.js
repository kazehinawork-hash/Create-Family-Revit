import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findClosestSample, scoreSample, tokenize } from "../src/samples.js";

/**
 * The saved-model library is local user data (git-ignored), so the test builds its
 * own tee inside a temporary folder instead of depending on `saved-models/`.
 */
function teeEntry() {
  return {
    id: "fixture-mitered-tee",
    name: "Thịnh Phát ICT - Tê Thang Cáp Vát Góc 45°",
    spec: {
      name: "Thịnh Phát ICT - Tê Thang Cáp Vát Góc 45°",
      typeName: "Tee Thang Cáp 400x300",
      category: "Electrical Equipment",
      description: "Phụ kiện tee thang cáp, nhánh xiên 45 độ, có nắp đậy và connector.",
      parts: [
        { name: "Corner Rail" },
        { name: "Rung" },
        { name: "Branch Rail" },
      ],
    },
  };
}

function sampleDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-samples-"));
  const entry = teeEntry();
  fs.writeFileSync(path.join(dir, `${entry.id}.json`), JSON.stringify(entry));
  return dir;
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
  const dir = sampleDir();

  const match = findClosestSample("làm tee thang cáp có nhánh 400x300", { dir });
  assert.ok(match, "a tee request should match the saved tee");
  assert.equal(match.id, teeEntry().id);

  assert.equal(findClosestSample("tạo bồn nước inox 2000 lít", { dir }), null);
  assert.equal(findClosestSample("tee thang cáp", { dir: path.join(dir, "missing") }), null);
});
