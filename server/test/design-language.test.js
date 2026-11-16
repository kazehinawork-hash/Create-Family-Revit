import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { design } from "../src/designer.js";
import { clearCachedResults } from "../src/result-cache.js";
import { designRequest } from "../src/schemas.js";

process.env.AGENT_EXPERIMENTAL_PIPELINE = "0";
delete process.env.AGENT_TEMPLATE;

beforeEach(() => clearCachedResults());

function boxSpec() {
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
        name: "Thân",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 600, y: 400, z: 200 } },
      },
    ],
    notes: [],
  };
}

async function userTextFor(language) {
  let seen = "";
  await design({
    prompt: "tạo mới hộp điện",
    currentSpec: null,
    lod: 300,
    emit: () => {},
    model: "cheap-model",
    language,
    generate: async (messages) => {
      seen = messages.map((message) => JSON.stringify(message.content)).join("\n");
      return { json: boxSpec(), text: "", usage: null };
    },
  });
  return seen;
}

test("the agent is told to answer in the selected language", async () => {
  assert.match(await userTextFor("en"), /Write every user-facing explanation.*English/);
  assert.match(await userTextFor("zh"), /所有面向用户的说明.*简体中文/);
  assert.match(await userTextFor("vi"), /Viết mọi giải thích.*tiếng Việt/);
});

test("the language field is validated", () => {
  assert.equal(designRequest.safeParse({ prompt: "x", language: "en" }).success, true);
  assert.equal(designRequest.safeParse({ prompt: "x", language: "zh" }).success, true);
  assert.equal(designRequest.safeParse({ prompt: "x", language: "vi" }).success, true);
  assert.equal(designRequest.safeParse({ prompt: "x", language: "fr" }).success, false);
});
