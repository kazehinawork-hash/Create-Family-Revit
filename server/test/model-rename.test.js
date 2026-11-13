import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeModel(dir, id, name) {
  const filePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        id,
        name,
        spec: { schemaVersion: "1.0", name, typeName: name, category: "Electrical Equipment", parameters: [], parts: [] },
        entries: [],
        savedAt: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ping`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not start");
}

test("PATCH /api/models/:id renames the saved spec without touching the id", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-models-"));
  const port = 19000 + Math.floor(Math.random() * 800);
  const baseUrl = `http://127.0.0.1:${port}`;
  const id = "mitered-tee";
  writeModel(dir, id, "Thinh Phat Cable Ladder");

  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      FAMILY_SAVED_DIR: dir,
      FAMILY_AGENT_BRIDGE: "0",
    },
    stdio: "ignore",
  });

  t.after(() => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);

  const changed = "Cable Ladder Mitered Tee 600";
  const response = await fetch(`${baseUrl}/api/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: changed }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.name, changed);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  assert.equal(saved.spec.name, changed);
  assert.equal(saved.spec.typeName, changed);
  assert.equal(saved.name, changed);
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true, "the file keeps its id");

  const history = fs.readdirSync(path.join(dir, ".history", id));
  assert.equal(history.length, 1, "a rename writes one revision");

  const empty = await fetch(`${baseUrl}/api/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(empty.status, 400);

  const tooLong = await fetch(`${baseUrl}/api/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(121) }),
  });
  assert.equal(tooLong.status, 400);

  const forbidden = await fetch(`${baseUrl}/api/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ladder 400/300" }),
  });
  assert.equal(forbidden.status, 400);

  const missing = await fetch(`${baseUrl}/api/models/does-not-exist`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Anything" }),
  });
  assert.equal(missing.status, 404);

  // Rejected renames left the stored name alone.
  const after = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  assert.equal(after.spec.name, changed);
});
