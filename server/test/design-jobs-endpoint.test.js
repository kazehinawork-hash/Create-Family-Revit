import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JOBS_DIR } from "../src/jobs.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitForServer(baseUrl) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const response = await fetch(`${baseUrl}/api/ping`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // not listening yet
      }
      if (attempts > 60) {
        reject(new Error("server did not start"));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

test("design jobs endpoint, heartbeat and disk survival", async (t) => {
  // A provider that never answers keeps the design run (and its heartbeat) alive.
  const provider = http.createServer(() => {
    // Intentionally hold the response open.
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;

  const port = 20000 + Math.floor(Math.random() * 800);
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AGENT_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      DESIGN_HEARTBEAT_MS: "120",
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
    try {
      provider.close();
    } catch {
      // already closed
    }
  });

  await waitForServer(baseUrl);

  // 1) Unknown job -> 404 with a clear message.
  const missing = await fetch(`${baseUrl}/api/design/jobs/djs_does_not_exist`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.match(missingBody.error, /restart|Không tìm thấy/i);

  // 2) The stream announces a job id immediately and pings while the agent works.
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/design`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Tạo hộp 500 x 300 x 200 mm." }),
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline && (!text.includes('"type":"job"') || !text.includes(": ping"))) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  try {
    await reader.cancel();
  } catch {
    // stream already gone
  }

  assert.match(text, /"type":"job"/, "the first frame carries the job id");
  assert.match(text, /: ping/, "the stream sends keep-alive pings while the agent runs");

  const jobId = text.match(/"jobId":"([^"]+)"/)?.[1];
  assert.ok(jobId, "a job id was announced");

  // The running job is queryable right away.
  const running = await fetch(`${baseUrl}/api/design/jobs/${jobId}`);
  assert.equal(running.status, 200);
  const runningBody = await running.json();
  assert.equal(runningBody.job.status, "running");

  // 3) A finished job written to disk is served by a freshly started server.
  const persistedId = `djs_persisted_${Date.now()}`;
  const persistedPath = path.join(JOBS_DIR, `${persistedId}.json`);
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(
    persistedPath,
    JSON.stringify({
      job_id: persistedId,
      kind: "design",
      status: "done",
      spec: { schemaVersion: "1.0", name: "Restored", category: "Generic Model", units: "mm", parameters: [], parts: [] },
      stats: { parts: 0, parameters: 0 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    "utf8",
  );

  try {
    const restored = await fetch(`${baseUrl}/api/design/jobs/${persistedId}`);
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json();
    assert.equal(restoredBody.job.status, "done");
    assert.equal(restoredBody.job.spec.name, "Restored");
  } finally {
    fs.rmSync(persistedPath, { force: true });
    try {
      fs.rmSync(path.join(JOBS_DIR, `${jobId}.json`), { force: true });
    } catch {
      // ignore
    }
  }
});
