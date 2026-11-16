// Importing index.js must not open the real port, and all model history lives in temp dirs.
process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const savedDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-history-"));
const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-history-jobs-"));
process.env.FAMILY_SAVED_DIR = savedDir;
process.env.FAMILY_JOBS_DIR = jobsDir;
process.env.HISTORY_KEEP = "20";

const { app } = await import("../src/index.js");
const { pruneHistories } = await import("../src/cleanup.js");

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(savedDir, { recursive: true, force: true });
  fs.rmSync(jobsDir, { recursive: true, force: true });
});

async function api(method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

function spec(name) {
  return {
    schemaVersion: "1.0",
    name,
    category: "Electrical Equipment",
    units: "mm",
    parameters: [],
    parts: [
      {
        id: "body",
        name: "Thân",
        solid: { kind: "box", origin: { x: 0, y: 0, z: 0 }, size: { x: 500, y: 300, z: 150 } },
      },
    ],
  };
}

async function save(id, name) {
  const result = await api("POST", "/api/models", { id, name, spec: spec(name) });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

function historyDir(id) {
  return path.join(savedDir, ".history", id);
}

function revisionNames(id) {
  return fs
    .readdirSync(historyDir(id))
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(historyDir(id), file), "utf8")).spec.name)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

test("only the newest HISTORY_KEEP revisions are kept", async () => {
  const id = "history-keep-20";
  await save(id, "v0");
  for (let version = 1; version <= 25; version += 1) {
    // archiveModel stamps with milliseconds: keep the names distinct.
    await new Promise((resolve) => setTimeout(resolve, 3));
    await save(id, `v${version}`);
  }

  assert.equal(revisionNames(id).length, 20, "20 newest revisions remain");
  assert.deepEqual(
    revisionNames(id),
    Array.from({ length: 20 }, (_, index) => `v${index + 5}`),
    "the five oldest revisions were deleted",
  );

  const listed = await api("GET", `/api/models/${id}/history`);
  assert.equal(listed.data.keep, 20);
  assert.equal(listed.data.revisions.length, 20);
});

test("HISTORY_KEEP=0 keeps every revision", async () => {
  process.env.HISTORY_KEEP = "0";
  try {
    const id = "history-keep-20";
    for (let version = 26; version <= 30; version += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3));
      await save(id, `v${version}`);
    }

    assert.equal(revisionNames(id).length, 25, "nothing is deleted when the limit is 0");
    assert.equal(revisionNames(id).at(-1), "v29");

    const listed = await api("GET", `/api/models/${id}/history`);
    assert.equal(listed.data.keep, 0);
    assert.equal(listed.data.revisions.length, 25);
  } finally {
    process.env.HISTORY_KEEP = "20";
  }
});

test("a strange id cannot escape its .history folder", async () => {
  const result = await save("../../evil", "Evil");
  assert.equal(result.id, "evil");

  await new Promise((resolve) => setTimeout(resolve, 3));
  await save("../../evil", "Evil v2");

  assert.equal(fs.existsSync(path.join(savedDir, "evil.json")), true);
  assert.equal(fs.existsSync(path.join(savedDir, "..", "evil.json")), false, "no file above saved/");
  assert.equal(fs.existsSync(path.join(savedDir, ".history", "evil.json")), false);

  for (const name of fs.readdirSync(path.join(savedDir, ".history"))) {
    assert.doesNotMatch(name, /[\\/]|\.\./, "history entries stay direct children");
  }
});

test("maintenance prunes every history folder that exceeds the limit", () => {
  const dir = path.join(savedDir, ".history", "maintenance-model");
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 25; index += 1) {
    fs.writeFileSync(path.join(dir, `2026-01-${String(index + 1).padStart(2, "0")}T00-00-00-000Z.json`), "{}");
  }
  // A folder that belongs to a model inside the trash must not be touched by this pass.
  const trashed = path.join(savedDir, ".trash", "trashed__1", "history");
  fs.mkdirSync(trashed, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(trashed, `2026-01-0${index + 1}T00-00-00-000Z.json`), "{}");
  }

  // The live 25-revision model from the previous test is trimmed too (5 files),
  // plus the 5 oldest files in this synthetic folder.
  assert.deepEqual(pruneHistories({ savedDir, keep: 20 }), { removed: 10 });
  assert.equal(fs.readdirSync(dir).length, 20);
  assert.equal(fs.existsSync(path.join(dir, "2026-01-01T00-00-00-000Z.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "2026-01-06T00-00-00-000Z.json")), true);
  assert.equal(fs.readdirSync(historyDir("history-keep-20")).length, 20);
  assert.equal(fs.readdirSync(trashed).length, 3, "trash history is untouched");
});
