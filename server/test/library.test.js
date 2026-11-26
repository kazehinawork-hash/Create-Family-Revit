// Importing index.js must not open the real port, and the library lives in a temp dir.
process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { slugifyModelName } from "../src/library.js";

const savedDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-library-"));
process.env.FAMILY_SAVED_DIR = savedDir;

// These modules read config.dirs.saved at import time, so they load after the env.
const { cleanupUploads } = await import("../src/cleanup.js");
const { cleanupTrash, listTrash } = await import("../src/trash.js");
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

  const renamed = await api("PATCH", "/api/library/groups/Thang%20c%C3%A1p", {
    name: "Thang cáp điện",
  });
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

  const renamed = await api("PATCH", "/api/library/groups/Nh%C3%B3m%20c%C5%A9", {
    name: "Nhóm mới",
  });
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

test("a near-uniform thumbnail is not advertised to the library", async () => {
  const saved = await saveModel({ name: "Ảnh thu nhỏ", spec: spec("Ảnh thu nhỏ") });
  const thumbFile = path.join(savedDir, `${saved.id}.thumb.jpg`);

  // A blank preview compresses to a few hundred bytes: the card must fall back to
  // its category icon instead of showing a flat square.
  fs.writeFileSync(thumbFile, Buffer.alloc(600, 240));
  let models = (await api("GET", "/api/models")).data.models;
  assert.equal(models.find((model) => model.id === saved.id).thumbUrl, null);

  fs.writeFileSync(thumbFile, Buffer.alloc(4096, 128));
  models = (await api("GET", "/api/models")).data.models;
  assert.match(models.find((model) => model.id === saved.id).thumbUrl, /\/thumb$/);
});

test("model slugs keep Vietnamese names readable", () => {
  assert.equal(slugifyModelName("Ngã tư thang cáp Thịnh Phát"), "nga-tu-thang-cap-thinh-phat");
  assert.equal(slugifyModelName("Cút gió chữ nhật 90°"), "cut-gio-chu-nhat-90");
  assert.equal(slugifyModelName("Đường ống PCCC"), "duong-ong-pccc");
  assert.equal(slugifyModelName("   "), "family");
  assert.equal(slugifyModelName("A".repeat(80)).length, 60);
});

test("a new model id is built from the Vietnamese name", async () => {
  const saved = await saveModel({
    name: "Ngã tư thang cáp Thịnh Phát",
    spec: spec("Ngã tư thang cáp Thịnh Phát"),
  });
  assert.match(saved.id, /-nga-tu-thang-cap-thinh-phat$/);
});

test("the listing reports how adjustable each family is", async () => {
  const model = spec("Điều chỉnh");
  model.parameters = [
    { name: "Width", type: "Length", group: "Dimensions", value: 400 },
    { name: "Overall Height", type: "Length", group: "Dimensions", value: 900 },
    { name: "Air Flow", type: "Number", group: "Mechanical", value: 1200 },
  ];
  model.parts[0].solid.size.x = "[Width]";

  const saved = await saveModel({ name: "Điều chỉnh", spec: model });
  const listed = (await api("GET", "/api/models")).data.models.find(
    (entry) => entry.id === saved.id,
  );
  assert.deepEqual(listed.usability, { parameters: 3, driving: 1, dead: 1 });
});

test("the thumbnail endpoint only writes .thumb.jpg", async () => {
  const saved = await saveModel({ name: "Ảnh mới", spec: spec("Ảnh mới") });
  const filePath = path.join(savedDir, `${saved.id}.json`);
  const before = fs.readFileSync(filePath, "utf8");
  const beforeMtime = fs.statSync(filePath).mtimeMs;

  const image = `data:image/jpeg;base64,${Buffer.alloc(4096, 7).toString("base64")}`;
  const uploaded = await api("POST", `/api/models/${saved.id}/thumb`, { thumbnail: image });
  assert.equal(uploaded.status, 200);
  assert.equal(fs.existsSync(path.join(savedDir, `${saved.id}.thumb.jpg`)), true);

  assert.equal(fs.readFileSync(filePath, "utf8"), before, "the model JSON is untouched");
  assert.equal(fs.statSync(filePath).mtimeMs, beforeMtime, "savedAt does not change");

  const listed = (await api("GET", "/api/models")).data.models.find(
    (entry) => entry.id === saved.id,
  );
  assert.match(listed.thumbUrl, /\/api\/models\/.+\/thumb$/);
});

test("the thumbnail endpoint rejects an unsafe id and a non-data URL", async () => {
  const saved = await saveModel({ name: "Ảnh lỗi", spec: spec("Ảnh lỗi") });
  const image = `data:image/jpeg;base64,${Buffer.alloc(4096, 7).toString("base64")}`;

  const badId = await api("POST", `/api/models/${encodeURIComponent("../evil")}/thumb`, {
    thumbnail: image,
  });
  assert.ok([400, 404].includes(badId.status), `got ${badId.status}`);

  const badImage = await api("POST", `/api/models/${saved.id}/thumb`, {
    thumbnail: "not-a-data-url",
  });
  assert.equal(badImage.status, 400);
  assert.equal(fs.existsSync(path.join(savedDir, `${saved.id}.thumb.jpg`)), false);
});

test("delete moves a model to the trash and restore returns it to its group", async () => {
  const saved = await saveModel({ name: "Trash me", spec: spec("Trash me"), group: "Nhóm rác" });

  const removed = await api("DELETE", `/api/models/${saved.id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.trashed, true);
  assert.ok(removed.data.key.startsWith(`${saved.id}__`));

  const listed = (await api("GET", "/api/models")).data.models;
  assert.equal(listed.some((model) => model.id === saved.id), false, "trashed model leaves the library");

  const trash = (await api("GET", "/api/trash")).data.items;
  const entry = trash.find((item) => item.id === saved.id);
  assert.ok(entry, "the trashed model is listed");
  assert.equal(entry.name, "Trash me");
  assert.equal(entry.group, "Nhóm rác");
  assert.ok(entry.daysLeft <= 30 && entry.daysLeft >= 29);

  const restored = await api("POST", `/api/trash/${encodeURIComponent(entry.key)}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.group, "Nhóm rác");
  assert.equal(fs.existsSync(path.join(savedDir, ".trash", entry.key)), false);

  const models = (await api("GET", "/api/models")).data.models;
  assert.equal(models.find((model) => model.id === saved.id).group, "Nhóm rác");
});

test("restoring onto an existing model id is refused", async () => {
  const saved = await saveModel({ name: "Conflict", spec: spec("Conflict") });
  await api("DELETE", `/api/models/${saved.id}`);
  const key = listTrash(savedDir).find((item) => item.id === saved.id).key;

  await saveModel({ id: saved.id, name: "Conflict", spec: spec("Conflict") });

  const restored = await api("POST", `/api/trash/${encodeURIComponent(key)}/restore`);
  assert.equal(restored.status, 409);
  assert.match(restored.data.error, /cùng ID/);
});

test("deleting the same id twice keeps both trash entries", async () => {
  const first = await saveModel({ name: "Double v1", spec: spec("Double v1") });
  await api("DELETE", `/api/models/${first.id}`);
  await saveModel({ id: first.id, name: "Double v2", spec: spec("Double v2") });
  await api("DELETE", `/api/models/${first.id}`);

  const entries = listTrash(savedDir).filter((item) => item.id === first.id);
  assert.equal(entries.length, 2, "both versions stay in the trash");
  const [newer, older] = entries;

  const restoredOld = await api("POST", `/api/trash/${encodeURIComponent(older.key)}/restore`);
  assert.equal(restoredOld.status, 200);
  const oldModel = (await api("GET", `/api/models/${first.id}`)).data;
  assert.equal(oldModel.spec.name, "Double v1");

  // Free the id, then restore the newer version and check its own content.
  const again = await api("DELETE", `/api/models/${first.id}`);
  await api("DELETE", `/api/trash/${encodeURIComponent(again.data.key)}`);
  const restoredNew = await api("POST", `/api/trash/${encodeURIComponent(newer.key)}/restore`);
  assert.equal(restoredNew.status, 200);
  const newModel = (await api("GET", `/api/models/${first.id}`)).data;
  assert.equal(newModel.spec.name, "Double v2");
});

test("legacy .trash/<id> entries are still listed and restored", async () => {
  const legacyId = "legacy-model";
  const legacyDir = path.join(savedDir, ".trash", legacyId);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "meta.json"),
    JSON.stringify({ id: legacyId, name: "Legacy", deletedAt: Date.now() - 1000, group: "" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(legacyDir, `${legacyId}.json`),
    JSON.stringify({ spec: { name: "Legacy" }, name: "Legacy", group: "" }),
    "utf8",
  );

  const entry = (await api("GET", "/api/trash")).data.items.find((item) => item.id === legacyId);
  assert.ok(entry, "legacy entry is listed");
  assert.equal(entry.key, legacyId);

  const restored = await api("POST", `/api/trash/${legacyId}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(fs.existsSync(path.join(savedDir, `${legacyId}.json`)), true);
  assert.equal(fs.existsSync(legacyDir), false);
});

test("trash entries past the retention window are purged", async () => {
  const saved = await saveModel({ name: "Old trash", spec: spec("Old trash") });
  await api("DELETE", `/api/models/${saved.id}`);
  const entry = listTrash(savedDir).find((item) => item.id === saved.id);

  const purged = cleanupTrash(savedDir, { ttlDays: 30, now: Date.now() + 31 * 24 * 60 * 60 * 1000 });
  assert.ok(purged.removed >= 1);
  assert.equal(fs.existsSync(path.join(savedDir, ".trash", entry.key)), false);
  assert.equal(listTrash(savedDir).some((item) => item.id === saved.id), false);
});

test("an id with a path separator is rejected", async () => {
  const traversal = encodeURIComponent("../evil");
  const modelDelete = await api("DELETE", `/api/models/${traversal}`);
  assert.ok([400, 404].includes(modelDelete.status), `got ${modelDelete.status}`);

  const restore = await api("POST", `/api/trash/${traversal}/restore`);
  assert.ok([400, 404].includes(restore.status), `got ${restore.status}`);

  assert.equal(fs.existsSync(path.join(savedDir, "..", "evil.json")), false);
});

test("uploads referenced by a trashed model are kept until it is purged", async () => {
  const saved = await saveModel({ name: "Has upload", spec: spec("Has upload") });
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "family-uploads-"));
  test.after(() => fs.rmSync(uploads, { recursive: true, force: true }));

  const attachment = path.join(uploads, "datasheet-trash.pdf");
  fs.writeFileSync(attachment, "pdf", "utf8");
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(attachment, old, old);

  // The saved model points at the upload; after trashing, the reference travels too.
  const file = path.join(savedDir, `${saved.id}.json`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.entries = [{ path: attachment }];
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  await api("DELETE", `/api/models/${saved.id}`);
  const key = listTrash(savedDir).find((item) => item.id === saved.id).key;

  const kept = cleanupUploads({ dir: uploads, savedDir, ttlDays: 14 });
  assert.equal(kept.removed, 0);
  assert.equal(fs.existsSync(attachment), true);

  await api("DELETE", `/api/trash/${encodeURIComponent(key)}`);
  const removed = cleanupUploads({ dir: uploads, savedDir, ttlDays: 14 });
  assert.equal(removed.removed, 1);
  assert.equal(fs.existsSync(attachment), false);
});

test("permanent delete and empty trash remove the folders", async () => {
  const one = await saveModel({ name: "Purge one", spec: spec("Purge one") });
  const two = await saveModel({ name: "Purge two", spec: spec("Purge two") });
  await api("DELETE", `/api/models/${one.id}`);
  await api("DELETE", `/api/models/${two.id}`);
  const entries = listTrash(savedDir);
  const oneEntry = entries.find((item) => item.id === one.id);
  const twoEntry = entries.find((item) => item.id === two.id);

  const purged = await api("DELETE", `/api/trash/${encodeURIComponent(oneEntry.key)}`);
  assert.equal(purged.status, 200);
  assert.equal(fs.existsSync(path.join(savedDir, ".trash", oneEntry.key)), false);

  const emptied = await api("DELETE", "/api/trash");
  assert.equal(emptied.status, 200);
  assert.equal(fs.existsSync(path.join(savedDir, ".trash", twoEntry.key)), false);
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

test("loading a legacy model migrates its spec in memory without overwriting the file on disk", async () => {
  const id = "legacy-elbow-test";
  const filePath = path.join(savedDir, `${id}.json`);
  const legacyPayload = {
    id,
    name: "Legacy Elbow",
    spec: {
      schemaVersion: "1.0",
      name: "Legacy Elbow",
      category: "Cable Tray Fitting",
      units: "mm",
      parameters: [
        { name: "Rung Length", type: "Length", value: 400 },
        { name: "Rung Slot Length", type: "Length", value: 25 },
        { name: "Rung Slot Spacing", type: "Length", formula: "([Rung Length] - [Rung Slot Length] - 1mm0mm) / 2" },
      ],
      parts: [
        {
          id: "rail",
          name: "Rail",
          solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: "[Rung Length]", y: 15, z: 100 } },
        },
      ],
    },
  };
  const diskBefore = JSON.stringify(legacyPayload);
  fs.writeFileSync(filePath, diskBefore, "utf8");

  const loaded = await api("GET", `/api/models/${id}`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.data.migrated, true);
  assert.equal(loaded.data.spec.specVersion, 2);
  assert.equal(
    loaded.data.spec.parameters.find((p) => p.name === "Rung Slot Spacing").formula,
    "([Rung Length] - [Rung Slot Length] - 10mm) / 2",
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), diskBefore);
});
