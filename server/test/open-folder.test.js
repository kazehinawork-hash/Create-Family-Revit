import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

process.env.FAMILY_AGENT_NO_LISTEN = "1";
process.env.NODE_ENV = "test";

const { app } = await import("../src/index.js");
const { config } = await import("../src/config.js");

test("POST /api/open-folder rejects outside paths and opens files inside allowed build roots", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  fs.mkdirSync(config.dirs.out, { recursive: true });
  const sampleFile = path.join(config.dirs.out, `open-folder-test-${Date.now()}.rfa`);
  fs.writeFileSync(sampleFile, "test-rfa");

  try {
    const missingPath = await fetch(`${baseUrl}/api/open-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missingPath.status, 400);

    const outside = await fetch(`${baseUrl}/api/open-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "C:\\Windows\\System32\\notepad.exe" }),
    });
    assert.equal(outside.status, 403);

    const notFound = await fetch(`${baseUrl}/api/open-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(config.dirs.out, "nonexistent-file.rfa") }),
    });
    assert.equal(notFound.status, 403);

    const ok = await fetch(`${baseUrl}/api/open-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sampleFile }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.folder, path.dirname(sampleFile));
  } finally {
    fs.rmSync(sampleFile, { force: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
