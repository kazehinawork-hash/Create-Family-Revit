import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../src/files.js";

test("writeJsonAtomic writes readable JSON and leaves no temp file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "family-agent-atomic-"));
  const file = path.join(directory, "model.json");

  try {
    writeJsonAtomic(file, { id: "one", spec: { name: "Chair" } });

    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      id: "one",
      spec: { name: "Chair" },
    });
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
