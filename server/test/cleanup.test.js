import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ABANDONED_MESSAGE, cleanupJobs, cleanupUploads } from "../src/cleanup.js";

const DAY = 24 * 60 * 60 * 1000;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-cleanup-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJob(dir, id, status, ageMs) {
  const stamp = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ job_id: id, status, created_at: stamp, updated_at: stamp }),
    "utf8",
  );
  return path.join(dir, `${id}.json`);
}

test("finished jobs older than the TTL are deleted, fresh ones stay", () => {
  const dir = tempDir();
  writeJob(dir, "old-done", "done", 8 * DAY);
  writeJob(dir, "old-error", "error", 8 * DAY);
  writeJob(dir, "recent", "succeeded", 1 * DAY);

  const result = cleanupJobs({ dir, ttlDays: 7 });

  assert.equal(result.removed, 2);
  assert.equal(fs.existsSync(path.join(dir, "old-done.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "old-error.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "recent.json")), true);
});

test("a job stuck running for a day is flagged as abandoned", () => {
  const dir = tempDir();
  const file = writeJob(dir, "stuck", "running", 25 * 60 * 60 * 1000);
  writeJob(dir, "alive", "awaiting_revit", 2 * 60 * 60 * 1000);

  const result = cleanupJobs({ dir, stuckHours: 24 });

  assert.equal(result.abandoned, 1);
  const stuck = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stuck.status, "error");
  assert.equal(stuck.error, ABANDONED_MESSAGE);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "alive.json"), "utf8")).status,
    "awaiting_revit",
  );
});

test("cleanup forgets removed jobs from the in-memory cache", () => {
  const dir = tempDir();
  writeJob(dir, "cached", "done", 9 * DAY);
  const forgotten = [];

  cleanupJobs({ dir, ttlDays: 7, forget: (id) => forgotten.push(id) });

  assert.deepEqual(forgotten, ["cached"]);
});

test("old uploads are removed unless a saved model still references them", () => {
  const uploads = tempDir();
  const saved = tempDir();
  const old = new Date(Date.now() - 20 * DAY);

  for (const name of ["used.pdf", "unused.pdf", "fresh.png"]) {
    const file = path.join(uploads, name);
    fs.writeFileSync(file, "x", "utf8");
    if (name !== "fresh.png") fs.utimesSync(file, old, old);
  }
  fs.writeFileSync(
    path.join(saved, "family.json"),
    JSON.stringify({ id: "family", entries: [{ path: path.join(uploads, "used.pdf") }] }),
    "utf8",
  );

  const result = cleanupUploads({ dir: uploads, savedDir: saved, ttlDays: 14 });

  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(path.join(uploads, "used.pdf")), true);
  assert.equal(fs.existsSync(path.join(uploads, "unused.pdf")), false);
  assert.equal(fs.existsSync(path.join(uploads, "fresh.png")), true);
});
