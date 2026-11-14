import assert from "node:assert/strict";
import test from "node:test";

import { looksTruncated, parseModelJson } from "../src/llm.js";

test("a cut-off model answer is reported as OUTPUT_LIMIT, not as broken JSON", () => {
  const truncated =
    '{"schemaVersion":"1.0","name":"Cross","parts":[{"id":"a","name":"Rung 1","solid":{"kind":"box","size":{"x":35';

  assert.throws(
    () => parseModelJson(truncated),
    (error) => {
      assert.equal(error.code, "OUTPUT_LIMIT");
      assert.match(error.message, /\(OUTPUT_LIMIT\)/);
      assert.equal(error.raw, truncated);
      return true;
    },
  );
  assert.equal(looksTruncated(truncated), true);
});

test("an answer cut inside a quoted string is still OUTPUT_LIMIT", () => {
  const truncated = '{"name":"Ngã tư thang cáp","notes":["Thiếu 6 bậc thang, mặt lưng phải chia 2 lớp';

  assert.equal(looksTruncated(truncated), true);
  assert.throws(() => parseModelJson(truncated), /OUTPUT_LIMIT/);
});

test("a complete object followed by prose is not treated as truncated", () => {
  const text = '{"name":"Cross","parts":[]}\n\nGhi chú: nhớ kiểm tra lại bậc thang.';

  assert.equal(looksTruncated(text), false);
  assert.equal(parseModelJson(text).name, "Cross");
});

test("unescaped newlines and quotes inside strings are repaired", () => {
  const text =
    '{"name":"Cross","notes":["dòng một\n dòng hai"],"parts":[{"name":"Thành "góc" trái"}]}';

  assert.equal(looksTruncated(text), false);
  const spec = parseModelJson(text);
  assert.equal(spec.name, "Cross");
  assert.equal(spec.notes.length, 1);
  assert.match(spec.parts[0].name, /góc/);
});

test("a fenced answer with a trailing comma still parses", () => {
  const text = '```json\n{"name":"Pump","parts":[],}\n```';
  assert.deepEqual(parseModelJson(text), { name: "Pump", parts: [] });
});
