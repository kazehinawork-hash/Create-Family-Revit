// These tests cover the opt-in pipeline (templates, evidence, tiers, split steps).
process.env.AGENT_EXPERIMENTAL_PIPELINE = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateJson } from "../src/agents.js";
import { readEvidence, resolveVisionModel } from "../src/evidence-reader.js";
import { design } from "../src/designer.js";

const CUSTOM = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-test", model: "gpt-4o-vision" };

// 1x1 transparent PNG.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function photoFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "family-photo-")), "photo.png");
  fs.writeFileSync(file, PHOTO);
  return { path: file, name: "photo.png" };
}

test("a custom API config reports its real model name, never 'custom:api'", () => {
  const vision = resolveVisionModel({ requested: "custom:api", customApiConfig: CUSTOM });

  assert.equal(vision.model, "gpt-4o-vision");
  assert.equal(vision.customApiConfig.baseUrl, CUSTOM.baseUrl);
});

test("readEvidence forwards the custom API config and model to the vision call", async () => {
  const seen = [];
  const generate = async (messages, options) => {
    seen.push({ messages, options });
    return { json: { productType: "valve", dimensions: [] }, text: "", usage: null };
  };

  await readEvidence({
    prompt: "van bướm DN150",
    sources: { text: "van bướm DN150", images: [photoFile()], warnings: [] },
    generate,
    customApiConfig: CUSTOM,
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.customApiConfig.baseUrl, CUSTOM.baseUrl);
  assert.equal(seen[0].options.model, "gpt-4o-vision");
});

test("a CLI backend refuses image parts with a clear message", async () => {
  const messages = [
    { role: "system", content: "You are a mechanical engineer." },
    {
      role: "user",
      content: [
        { type: "text", text: "read this photo" },
        { type: "image", mime: "image/png", data: "AAAA" },
      ],
    },
  ];

  await assert.rejects(
    () => generateJson(messages, { model: "codex:gpt-6-astra:medium", timeoutMs: 5000 }),
    /Backend CLI không nhận ảnh/,
  );
});

test("design() without a generate override still sends the photo to the custom endpoint", async () => {
  const bodies = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    bodies.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: "1.0",
                name: "Valve",
                category: "Mechanical Equipment",
                units: "mm",
                parameters: [{ name: "Nominal Size", type: "Length", group: "Dimensions", value: 150 }],
                materials: [],
                parts: [],
                connectors: [],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await design({
      prompt: "van bướm DN150 theo ảnh",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "custom:api",
      customApiConfig: CUSTOM,
      attachments: [photoFile()],
    });

    assert.ok(bodies.length >= 1, "the endpoint was called");
    assert.ok(
      bodies.some((call) => call.body.includes("image_url")),
      "the photo reached the vision call",
    );
    assert.ok(bodies.every((call) => call.url.startsWith(CUSTOM.baseUrl)), "the custom base URL is used");
    assert.ok(result.analysis?.spec);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
