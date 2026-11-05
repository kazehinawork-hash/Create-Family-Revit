import assert from "node:assert/strict";
import test from "node:test";
import { cacheKey, readCachedResult, writeCachedResult } from "../src/result-cache.js";

test("result cache keys are stable and distinguish inputs", () => {
  assert.equal(cacheKey({ prompt: "a", spec: null }), cacheKey({ prompt: "a", spec: null }));
  assert.notEqual(cacheKey({ prompt: "a" }), cacheKey({ prompt: "b" }));
});

test("result cache stores and returns a value", () => {
  const key = cacheKey({ prompt: "cache-test", spec: { name: "Rack" } });
  assert.equal(readCachedResult(key), null);

  writeCachedResult(key, { analysis: { ok: true }, stats: { parts: 1 } });
  assert.deepEqual(readCachedResult(key), {
    analysis: { ok: true },
    stats: { parts: 1 },
  });
});
