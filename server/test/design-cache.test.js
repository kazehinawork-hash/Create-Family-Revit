import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";

process.env.AGENT_EXPERIMENTAL_PIPELINE = "0";
delete process.env.AGENT_TEMPLATE;

beforeEach(() => clearCachedResults());

function boxSpec(name = "Hộp điện", extraPart = false) {
  return {
    schemaVersion: "1.0",
    name,
    category: "Electrical Equipment",
    units: "mm",
    parameters: [],
    materials: [],
    connectors: [],
    parts: [
      {
        id: "body",
        name: "Thân hộp",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 600, y: 400, z: 200 } },
      },
      ...(extraPart
        ? [
            {
              id: "base",
              name: "Chân đế",
              solid: { kind: "box", origin: { x: 0, y: 0, z: -100 }, size: { x: 200, y: 200, z: 100 } },
            },
          ]
        : []),
    ],
    notes: [],
  };
}

function fakeModel(calls, specFor = () => boxSpec()) {
  return async () => {
    calls.push(1);
    return { json: specFor(calls.length), text: "", usage: null };
  };
}

test("re-sending the same new-family prompt always calls the model", async () => {
  const calls = [];
  const run = () =>
    design({
      prompt: "tạo mới hộp điện",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      generate: fakeModel(calls),
    });

  const first = await run();
  const second = await run();
  assert.equal(calls.length, 2, "a creation request must not be replayed from cache");
  assert.equal(first.stats.cached, undefined);
  assert.equal(second.stats.cached, undefined);
});

test("re-sending the same edit is served from cache", async () => {
  const calls = [];
  const run = (fresh) =>
    design({
      prompt: "thêm một chân đế",
      currentSpec: boxSpec(),
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      fresh,
      generate: fakeModel(calls, () => boxSpec("Hộp điện", true)),
    });

  await run();
  const cached = await run();
  assert.equal(calls.length, 1, "the second edit comes from cache");
  assert.equal(cached.stats.cached, true);
  assert.equal(typeof cached.stats.cachedAt, "number");
});

test("fresh=true skips the cache and refreshes it", async () => {
  const calls = [];
  const run = (fresh) =>
    design({
      prompt: "thêm một chân đế",
      currentSpec: boxSpec(),
      lod: 300,
      emit: () => {},
      model: "cheap-model",
      fresh,
      generate: fakeModel(calls, () => boxSpec("Hộp điện", true)),
    });

  await run();
  const freshRun = await run(true);
  assert.equal(calls.length, 2, "fresh must reach the model");
  assert.equal(freshRun.stats.cached, undefined);

  const cached = await run();
  assert.equal(calls.length, 2, "the fresh result replaces the cache entry");
  assert.equal(cached.stats.cached, true);
});

test("the experimental pipeline also skips cache for a new family", async () => {
  process.env.AGENT_EXPERIMENTAL_PIPELINE = "1";
  try {
    const calls = [];
    const run = () =>
      design({
        prompt: "tạo mới hộp điện",
        currentSpec: null,
        lod: 300,
        emit: () => {},
        model: "cheap-model",
        generate: fakeModel(calls),
      });

    const first = await run();
    const firstCalls = calls.length;
    const second = await run();
    assert.ok(calls.length > firstCalls, "a creation request must reach the model again");
    assert.equal(first.stats.cached, undefined);
    assert.equal(second.stats.cached, undefined);
  } finally {
    process.env.AGENT_EXPERIMENTAL_PIPELINE = "0";
  }
});
