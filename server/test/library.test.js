// Importing index.js must not open the real port, and the library lives in a temp dir.
process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const savedDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-library-"));
process.env.FAMILY_SAVED_DIR = savedDir;

const { app } = await import("../src/index.js");

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(savedDir, { recursive: true, force: true });
});

function spec(name = "Thang cáp 400") {
  return {
    schemaVersion: "1.0",
    name,
    typeName: `${name} type`,
    category: "Electrical Equipment",
    lod: 400,
    units: "mm",
    parameters: [{ name: "Width", type: "Length", group: "Dimensions", value: 400 }],
    materials: [],
    connectors: [],
    parts: [
      {
        id: "rail",
        name: "Thanh bên",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 400, y: 15, z: 100 } },
      },
    ],
    notes: [],
  };
}

async function api(method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function saveModel(payload) {
  const result = await api("POST", "/api/models", payload);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

test("a group can be created, renamed and deleted", async () => {
  const created = await api("POST", "/api/library/groups", { name: "  Thang cáp  " });
  assert.equal(created.status, 200);
  assert.equal(created.data.name, "Thang cáp");

  const duplicate = await api("POST", "/api/library/groups", { name: "thang CÁP" });
  assert.equal(duplicate.status, 400);

  const renamed = await api("PATCH", "/api/library/groups/Thang%20c%C3%A1p", { name: "Thang cáp điện" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, "Thang cáp điện");

  const removed = await api("DELETE", "/api/library/groups/Thang%20c%C3%A1p%20%C4%91i%E1%BB%87n");
  assert.equal(removed.status, 200);

  const list = await api("GET", "/api/library/groups");
  assert.deepEqual(
    list.data.groups.map((group) => group.name),
    [],
  );
});

test("saving a model and moving it between groups", async () => {
  const saved = await saveModel({ name: "Cáp A", spec: spec("Cáp A"), group: "Nhóm A" });
  assert.equal(saved.group, "Nhóm A");

  await saveModel({ name: "Cáp B", spec: spec("Cáp B") });

  let models = (await api("GET", "/api/models")).data.models;
  assert.equal(models.length, 2);
  assert.equal(models.find((model) => model.name === "Cáp A").group, "Nhóm A");
  assert.equal(models.find((model) => model.name === "Cáp B").group, "");
  // The list also carries LOD and typeName for the cards.
  assert.equal(models.find((model) => model.name === "Cáp A").lod, 400);
  assert.match(models.find((model) => model.name === "Cáp A").typeName, /type/);

  const moved = await api("PATCH", `/api/models/${saved.id}/group`, { group: "Nhóm B" });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.group, "Nhóm B");

  models = (await api("GET", "/api/models")).data.models;
  assert.equal(models.find((model) => model.id === saved.id).group, "Nhóm B");

  // Moving a model must not write a history revision.
  const history = await api("GET", `/api/models/${saved.id}/history`);
  assert.equal(history.data.revisions.length, 0);

  const back = await api("PATCH", `/api/models/${saved.id}/group`, { group: "" });
  assert.equal(back.data.group, "");
});

test("saving over an existing model keeps its group", async () => {
  const saved = await saveModel({ name: "Giữ nhóm", spec: spec("Giữ nhóm"), group: "Nhóm giữ" });

  // A plain Save from the studio sends no group (or a stale one): it must not move.
  const overwritten = await saveModel({
    id: saved.id,
    name: "Giữ nhóm",
    spec: spec("Giữ nhóm"),
    group: "",
  });
  assert.equal(overwritten.group, "Nhóm giữ");

  const models = (await api("GET", "/api/models")).data.models;
  assert.equal(models.find((model) => model.id === saved.id).group, "Nhóm giữ");

  // The revision still exists, so nothing else about Save changed.
  const history = await api("GET", `/api/models/${saved.id}/history`);
  assert.equal(history.data.revisions.length, 1);
});

test("renaming a group moves its models with it", async () => {
  const saved = await saveModel({ name: "Renamed", spec: spec("Renamed"), group: "Nhóm cũ" });

  const renamed = await api("PATCH", "/api/library/groups/Nh%C3%B3m%20c%C5%A9", { name: "Nhóm mới" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.updated, 1);

  const models = (await api("GET", "/api/models")).data.models;
  assert.equal(models.find((model) => model.id === saved.id).group, "Nhóm mới");
});

test("deleting a group keeps its models and moves them to Chưa nhóm", async () => {
  const saved = await saveModel({ name: "Xoá nhóm", spec: spec("Xoá nhóm"), group: "Nhóm tạm" });

  const removed = await api("DELETE", "/api/library/groups/Nh%C3%B3m%20t%E1%BA%A1m");
  assert.equal(removed.status, 200);

  const models = (await api("GET", "/api/models")).data.models;
  const model = models.find((entry) => entry.id === saved.id);
  assert.ok(model, "the model itself is never deleted");
  assert.equal(model.group, "");
});

test("_library.json never shows up as a model", async () => {
  await saveModel({ name: "Kiểm tra", spec: spec("Kiểm tra"), group: "Nhóm ẩn" });
  assert.ok(fs.existsSync(path.join(savedDir, "_library.json")));

  const models = (await api("GET", "/api/models")).data.models;
  assert.equal(
    models.some((model) => model.id.startsWith("_")),
    false,
  );
});

test("invalid group names are rejected with 400", async () => {
  for (const name of ["", "   ", "a".repeat(61), "Nhóm/độc", 'Nhóm"x', "Nhóm<1>"]) {
    const result = await api("POST", "/api/library/groups", { name });
    assert.equal(result.status, 400, `"${name}" must be rejected`);
  }

  const saved = await saveModel({ name: "Tên nhóm", spec: spec("Tên nhóm") });
  const moved = await api("PATCH", `/api/models/${saved.id}/group`, { group: "Nhóm:1" });
  assert.equal(moved.status, 400);
});
