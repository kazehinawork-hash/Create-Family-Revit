import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { v1Router } from "../src/routes/api-v1.js";
import { ROOT } from "../src/config.js";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", v1Router);
  return app;
}

// Mock in-process request dispatcher without TCP sockets to work seamlessly in sandboxed test runners
async function makeRequest(app, method, url, body = null, headers = {}) {
  return new Promise((resolve) => {
    const [pathPart, queryPart] = url.split("?");
    const query = {};
    if (queryPart) {
      for (const pair of queryPart.split("&")) {
        const [k, v] = pair.split("=");
        query[decodeURIComponent(k)] = decodeURIComponent(v || "");
      }
    }

    const req = {
      method: method.toUpperCase(),
      url,
      path: pathPart,
      originalUrl: url,
      baseUrl: "",
      query,
      headers: {
        host: "127.0.0.1:8787",
        ...headers,
      },
      body: body || {},
      get(header) {
        return this.headers[header.toLowerCase()];
      },
    };

    let statusCode = 200;
    let responseBody = null;
    const responseHeaders = {};

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      setHeader(k, v) {
        responseHeaders[k.toLowerCase()] = v;
        return this;
      },
      json(data) {
        responseBody = data;
        resolve({
          status: statusCode,
          ok: statusCode >= 200 && statusCode < 300,
          body: responseBody,
          headers: responseHeaders,
        });
      },
      send(data) {
        responseBody = data;
        resolve({
          status: statusCode,
          ok: statusCode >= 200 && statusCode < 300,
          body: responseBody,
          headers: responseHeaders,
        });
      },
    };

    app.handle(req, res, (err) => {
      if (err) {
        statusCode = 500;
        responseBody = { error: err.message };
      }
      resolve({
        status: statusCode,
        ok: statusCode >= 200 && statusCode < 300,
        body: responseBody,
        headers: responseHeaders,
      });
    });
  });
}

describe("API v1 Contract Tests (DG App ↔ Create-Family-Revit)", () => {
  const app = createTestApp();
  const validFcuSpec = JSON.parse(
    fs.readFileSync(path.join(ROOT, "spec", "examples", "fcu-080.json"), "utf8"),
  );

  it("GET /api/v1/status returns capability and version metadata", async () => {
    const res = await makeRequest(app, "GET", "/api/v1/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.api_version, "1.0");

    const data = res.body.data;
    assert.equal(data.service, "create-family-revit");
    assert.equal(data.api_version, "1.0");
    assert.equal(data.spec_schema_version, "1.0");
    assert.ok(Array.isArray(data.capabilities));
    assert.ok(data.capabilities.includes("validate"));
    assert.ok(data.capabilities.includes("preview"));
    assert.ok(data.capabilities.includes("build"));
    assert.ok(data.capabilities.includes("external_spec"));
    assert.ok(data.revit);
    assert.equal(typeof data.revit.bridge_connected, "boolean");
  });

  it("POST /api/v1/spec/validate succeeds for valid fixture without AI invocation", async () => {
    const res = await makeRequest(app, "POST", "/api/v1/spec/validate", {
      spec: validFcuSpec,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.valid, true);
    assert.ok(res.body.data.spec_hash);
    assert.ok(res.body.data.geometry_summary.bounds);
    assert.ok(res.body.data.geometry_summary.parts_count > 0);
  });

  it("POST /api/v1/spec/validate rejects invalid spec with structured error envelope", async () => {
    const invalidSpec = {
      name: "Bad Spec",
      category: "NotARealCategory",
      parameters: [{ name: "Width", type: "Length" }], // missing default
    };

    const res = await makeRequest(app, "POST", "/api/v1/spec/validate", {
      spec: invalidSpec,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, "INVALID_SPEC");
    assert.ok(res.body.error.details);
    assert.ok(res.body.error.details.errors.length > 0);
  });

  it("POST /api/v1/spec/validate rejects unsupported schema version", async () => {
    const res = await makeRequest(app, "POST", "/api/v1/spec/validate", {
      spec: validFcuSpec,
      schema_version: "99.0",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, "UNSUPPORTED_SCHEMA_VERSION");
  });

  it("POST /api/v1/spec/preview returns preview_id with spec_hash and geometry summary", async () => {
    const res = await makeRequest(app, "POST", "/api/v1/spec/preview", {
      spec: validFcuSpec,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.preview_id.startsWith("prev_"));
    assert.ok(res.body.data.spec_hash);
    assert.ok(res.body.data.geometry_summary.bounds);
  });

  it("POST /api/v1/build rejects stale preview if spec was modified", async () => {
    const previewRes = await makeRequest(app, "POST", "/api/v1/spec/preview", {
      spec: validFcuSpec,
    });
    const previewId = previewRes.body.data.preview_id;

    const modifiedSpec = {
      ...validFcuSpec,
      description: "Tampered spec description",
    };

    const buildRes = await makeRequest(app, "POST", "/api/v1/build", {
      spec: modifiedSpec,
      preview_id: previewId,
    });

    assert.equal(buildRes.status, 400);
    assert.equal(buildRes.body.ok, false);
    assert.equal(buildRes.body.error.code, "PREVIEW_STALE");
  });

  it("POST /api/v1/build enforces idempotency_key", async () => {
    const idempotencyKey = "test_key_" + Date.now();

    const res1 = await makeRequest(app, "POST", "/api/v1/build", {
      spec: validFcuSpec,
      idempotency_key: idempotencyKey,
    });

    assert.equal(res1.status, 202);
    assert.equal(res1.body.ok, true);
    const jobId = res1.body.data.job_id;
    assert.ok(jobId);

    // Second call with same idempotency key must return the existing job
    const res2 = await makeRequest(app, "POST", "/api/v1/build", {
      spec: validFcuSpec,
      idempotency_key: idempotencyKey,
    });

    assert.equal(res2.status, 200);
    assert.equal(res2.body.ok, true);
    assert.equal(res2.body.data.job_id, jobId);
    assert.equal(res2.body.data.duplicate, true);
  });

  it("GET /api/v1/jobs/:job_id returns job status and progress", async () => {
    const buildRes = await makeRequest(app, "POST", "/api/v1/build", {
      spec: validFcuSpec,
    });
    const jobId = buildRes.body.data.job_id;

    const jobRes = await makeRequest(app, "GET", `/api/v1/jobs/${jobId}`);
    assert.equal(jobRes.status, 200);
    assert.equal(jobRes.body.ok, true);
    assert.equal(jobRes.body.data.job_id, jobId);
    assert.ok(["queued", "running", "awaiting_revit", "failed", "succeeded"].includes(jobRes.body.data.status));
  });

  it("GET /api/v1/jobs/:job_id returns 404 for unknown job", async () => {
    const res = await makeRequest(app, "GET", "/api/v1/jobs/job_non_existent");
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, "JOB_NOT_FOUND");
  });
});
