import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";

process.env.AGENT_EXPERIMENTAL_PIPELINE = "0";
delete process.env.AGENT_TEMPLATE;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-attachments-"));
const imagePath = path.join(dir, "photo.png");
// Any small PNG is enough: the CLI only needs the file to exist in its workspace.
fs.writeFileSync(
  imagePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => clearCachedResults());

function boxSpec(extraPart = false) {
  return {
    schemaVersion: "1.0",
    name: "Hộp điện",
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

test("a new family passes the attachment to the CLI generate call", async () => {
  const seen = [];
  await design({
    prompt: "tạo mới hộp điện theo ảnh",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "agy:test",
    attachments: [{ path: imagePath, name: "photo.png" }],
    generate: async (_messages, options) => {
      seen.push(options);
      return { json: boxSpec(), text: "", usage: null };
    },
  });

  assert.ok(seen.length >= 1, "the model was called");
  for (const options of seen) {
    assert.ok(Array.isArray(options.attachments), "attachments reach the CLI options");
    assert.equal(options.attachments.length, 1);
    assert.equal(options.attachments[0].name, "photo.png");
    assert.equal(fs.existsSync(options.attachments[0].path), true, "the file exists at call time");
  }
});

test("an edit with a current spec also passes the attachment", async () => {
  const seen = [];
  await design({
    prompt: "thêm một chân đế theo ảnh",
    currentSpec: boxSpec(),
    lod: 300,
    emit: () => {},
    model: "agy:test",
    attachments: [{ path: imagePath, name: "photo.png" }],
    generate: async (_messages, options) => {
      seen.push(options);
      return { json: boxSpec(true), text: "", usage: null };
    },
  });

  assert.ok(seen.length >= 1);
  for (const options of seen) {
    assert.equal(options.attachments?.[0]?.name, "photo.png");
    assert.equal(fs.existsSync(options.attachments[0].path), true);
  }
});

test("a vision image part is not copied as a CLI attachment", async () => {
  const seen = [];
  await design({
    prompt: "tạo mới hộp điện theo ảnh",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    customApiConfig: { baseUrl: "https://example.test/v1", apiKey: "test", model: "gpt-vision", vision: true },
    attachments: [{ path: imagePath, name: "photo.png" }],
    generate: async (_messages, options) => {
      seen.push(options);
      return { json: boxSpec(), text: "", usage: null };
    },
  });

  assert.ok(seen.length >= 1);
  assert.equal(seen[0].attachments, undefined, "the pixels travel as an image part");
});

test("a missing attachment fails with a readable Vietnamese error", async () => {
  await assert.rejects(
    design({
      prompt: "tạo mới hộp điện",
      currentSpec: null,
      lod: 300,
      emit: () => {},
      model: "agy:test",
      attachments: [{ path: path.join(dir, "gone.png"), name: "gone.png" }],
      generate: async () => ({ json: boxSpec(), text: "", usage: null }),
    }),
    /Không tìm thấy tệp đính kèm "gone\.png" trên ổ đĩa/,
  );
});
