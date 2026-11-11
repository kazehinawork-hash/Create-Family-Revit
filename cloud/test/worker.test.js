import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CloudApp } from "../src/worker.js";

describe("Cloud Worker API Tests (Web Studio ↔ Cloud Worker ↔ Connector)", () => {
  const validSpec = {
    schemaVersion: "1.0",
    name: "Ball Valve DN50",
    category: "Generic Model",
    parameters: [{ name: "Size", type: "Length", value: 50 }],
    parts: [
      {
        name: "Body",
        solid: {
          kind: "box",
          origin: { x: 0, y: 0, z: 0 },
          size: { x: "Size", y: "Size", z: "Size" },
        },
      },
    ],
  };

  test("GET /api/v1/health returns healthy envelope", async () => {
    const app = new CloudApp();
    const res = await app.handleRequest(new Request("https://api.test/api/v1/health"));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.mode, "cloud-worker");
  });

  test("Full Vertical Slice: Submit Job -> Connector Poll -> Complete", async () => {
    const app = new CloudApp();

    // 1. Web Studio nộp job
    const submitReq = new Request("https://api.test/api/v1/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: validSpec }),
    });
    const submitRes = await app.handleRequest(submitReq);
    assert.equal(submitRes.status, 201);
    const submitBody = await submitRes.json();
    const jobId = submitBody.data.id;
    assert.ok(jobId);
    assert.equal(submitBody.data.status, "queued");

    // 2. Connector đăng ký
    const regReq = new Request("https://api.test/api/v1/connector/register", {
      method: "POST",
      headers: { "X-Connector-Id": "win-connector-1", "Content-Type": "application/json" },
      body: JSON.stringify({ revit_version: 2024 }),
    });
    const regRes = await app.handleRequest(regReq);
    assert.equal(regRes.status, 200);

    // 3. Connector poll job
    const pollReq = new Request("https://api.test/api/v1/connector/jobs/poll", {
      method: "GET",
      headers: { "X-Connector-Id": "win-connector-1" },
    });
    const pollRes = await app.handleRequest(pollReq);
    assert.equal(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assert.equal(pollBody.data.id, jobId);
    assert.equal(pollBody.data.status, "assigned");

    // 4. Connector báo hoàn thành kèm artifact
    const compReq = new Request(`https://api.test/api/v1/connector/jobs/${jobId}/complete`, {
      method: "POST",
      headers: { "X-Connector-Id": "win-connector-1", "Content-Type": "application/json" },
      body: JSON.stringify({
        artifacts: { rfa_file_name: "Ball Valve DN50.rfa", rfa_size_bytes: 409600 },
        metrics: { duration_ms: 2500, parts_built: 1 },
      }),
    });
    const compRes = await app.handleRequest(compReq);
    assert.equal(compRes.status, 200);

    // 5. Web Studio kiểm tra trạng thái job
    const statusReq = new Request(`https://api.test/api/v1/jobs/${jobId}`);
    const statusRes = await app.handleRequest(statusReq);
    const statusBody = await statusRes.json();

    assert.equal(statusBody.data.status, "completed");
    assert.equal(statusBody.data.progress, 100);
    assert.equal(statusBody.data.result.artifacts.rfa_file_name, "Ball Valve DN50.rfa");
  });
});
