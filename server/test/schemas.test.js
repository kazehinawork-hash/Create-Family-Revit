import assert from "node:assert/strict";
import test from "node:test";
import { buildRequest, designRequest, modelSaveRequest, uploadRequest } from "../src/schemas.js";

test("design requests need a non-empty prompt within the limit", () => {
  assert.equal(designRequest.safeParse({ prompt: "A fan coil" }).success, true);
  assert.equal(designRequest.safeParse({ prompt: "   " }).success, false);
  assert.equal(designRequest.safeParse({ prompt: "x".repeat(50001) }).success, false);
  assert.equal(designRequest.safeParse({ prompt: "ok", lod: "300" }).success, true);
  assert.equal(
    designRequest.safeParse({
      prompt: "ok",
      attachments: [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }, { path: "e" }],
    }).success,
    false,
  );
});

test("build requests must carry a spec field", () => {
  assert.equal(buildRequest.safeParse({ spec: { name: "Chair" } }).success, true);
  assert.equal(buildRequest.safeParse({}).success, false);
});

test("uploads need a name and base64 data", () => {
  assert.equal(uploadRequest.safeParse({ name: "a.pdf", data: "AAAA" }).success, true);
  assert.equal(uploadRequest.safeParse({ name: "a.pdf" }).success, false);
  assert.equal(uploadRequest.safeParse({ name: "", data: "AAAA" }).success, false);
});

test("saving a model requires a named spec", () => {
  assert.equal(modelSaveRequest.safeParse({ spec: { name: "Chair" } }).success, true);
  assert.equal(modelSaveRequest.safeParse({ spec: {} }).success, false);
  assert.equal(modelSaveRequest.safeParse({}).success, false);
});
