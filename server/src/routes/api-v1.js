import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { analyzeSpec } from "@family/spec-core";
import { config, ROOT } from "../config.js";
import { bridgeAlive, findRevitExe } from "../revit.js";
import { buildFamily } from "../bridge.js";
import { auditBuild } from "../build-qa.js";
import {
  computeSpecHash,
  savePreview,
  getPreview,
  createJob,
  getJob,
  updateJob,
  listJobs,
  setLatestExternalSpec,
  getLatestExternalSpec,
  subscribeExternalSpec,
} from "../jobs.js";

export const v1Router = express.Router();

const API_VERSION = "1.0";
const SPEC_SCHEMA_VERSION = "1.0";

// Read app version from package.json
let appVersion = "0.1.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.version) appVersion = pkg.version;
} catch {}

/**
 * Standard Envelope Generator
 */
function makeEnvelope(req, ok, data = null, error = null) {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  return {
    api_version: API_VERSION,
    request_id: requestId,
    ok,
    data,
    error: error
      ? {
          code: error.code || "INTERNAL_ERROR",
          message: error.message || "An unexpected error occurred",
          retryable: Boolean(error.retryable),
          details: error.details || {},
        }
      : null,
  };
}

/**
 * Optional External API Authentication Middleware
 * If DG_API_KEY or FAMILY_API_KEY is configured in env, require Bearer token or X-API-Key.
 * If not set, loopback trust applies.
 */
v1Router.use((req, res, next) => {
  const requiredKey = process.env.DG_API_KEY || process.env.FAMILY_API_KEY;
  if (!requiredKey) {
    return next();
  }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : (req.headers["x-api-key"] || "").trim();

  if (!token || token !== requiredKey.trim()) {
    return res.status(401).json(
      makeEnvelope(req, false, null, {
        code: "UNAUTHORIZED",
        message: "Missing or invalid API key for external integration",
        retryable: false,
      }),
    );
  }
  next();
});

/**
 * 1. GET /api/v1/status
 * Capabilities & readiness discovery
 */
v1Router.get("/status", async (req, res) => {
  try {
    const connected = await bridgeAlive();
    const revitExe = findRevitExe();

    const data = {
      service: "create-family-revit",
      app_version: appVersion,
      api_version: API_VERSION,
      spec_schema_version: SPEC_SCHEMA_VERSION,
      capabilities: ["validate", "preview", "build", "job_status", "external_spec"],
      revit: {
        version: config.revit.version,
        bridge_connected: connected,
        installed: Boolean(revitExe),
        auto_start: config.revit.autoStart,
      },
      status: connected ? "ready_for_build" : "ready_for_validation",
    };

    res.json(makeEnvelope(req, true, data));
  } catch (err) {
    res.status(500).json(
      makeEnvelope(req, false, null, {
        code: "APP_UNAVAILABLE",
        message: err.message,
        retryable: true,
      }),
    );
  }
});

/**
 * 2. POST /api/v1/spec/validate
 * Pure Spec-Core validation, zero AI invocation
 */
v1Router.post("/spec/validate", (req, res) => {
  const spec = req.body?.spec;
  if (!spec || typeof spec !== "object") {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Field 'spec' is required and must be an object",
        retryable: false,
      }),
    );
  }

  // Schema version check if supplied
  const clientSchemaVer = req.body?.schema_version || spec.schemaVersion;
  if (clientSchemaVer && String(clientSchemaVer) !== "1.0" && String(clientSchemaVer) !== "1") {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "UNSUPPORTED_SCHEMA_VERSION",
        message: `Schema version '${clientSchemaVer}' is not supported. Supported: '1.0'`,
        retryable: false,
      }),
    );
  }

  const analysis = analyzeSpec(spec);
  const specHash = computeSpecHash(spec);

  if (!analysis.ok) {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Spec failed validation checks",
        details: {
          errors: analysis.errors || [],
          warnings: analysis.warnings || [],
          issues: analysis.issues || [],
        },
      }),
    );
  }

  res.json(
    makeEnvelope(req, true, {
      valid: true,
      spec_hash: specHash,
      name: spec.name || "Family",
      category: spec.category,
      diagnostics: {
        errors: [],
        warnings: analysis.warnings || [],
      },
      parity_risks: analysis.parity || [],
      readiness: {
        parts: analysis.partParity?.length || 0,
        native_parts: (analysis.partParity || []).filter((part) => part.native).length,
        risk_parts: (analysis.partParity || []).filter((part) => part.risks.length > 0).length,
      },
      geometry_summary: {
        bounds: analysis.model?.bounds || null,
        parts_count: analysis.model?.parts?.length || 0,
        parameters_count: spec.parameters?.length || 0,
        connectors_count: spec.connectors?.length || 0,
      },
    }),
  );
});

/**
 * 3. POST /api/v1/spec/preview
 * Generate preview metadata & geometry summary tied to spec_hash
 */
v1Router.post("/spec/preview", (req, res) => {
  const spec = req.body?.spec;
  if (!spec || typeof spec !== "object") {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Field 'spec' is required",
        retryable: false,
      }),
    );
  }

  const analysis = analyzeSpec(spec);
  if (!analysis.ok) {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Spec has errors and cannot be previewed",
        details: { errors: analysis.errors },
      }),
    );
  }

  const specHash = computeSpecHash(spec);
  const preview = savePreview({
    spec,
    specHash,
    analysis,
    warnings: analysis.warnings || [],
  });

  res.json(
    makeEnvelope(req, true, {
      preview_id: preview.preview_id,
      spec_hash: preview.spec_hash,
      geometry_summary: preview.geometry_summary,
      warnings: preview.warnings,
      parity_risks: analysis.parity || [],
      readiness: {
        parts: analysis.partParity?.length || 0,
        native_parts: (analysis.partParity || []).filter((part) => part.native).length,
        risk_parts: (analysis.partParity || []).filter((part) => part.risks.length > 0).length,
      },
      created_at: preview.created_at,
    }),
  );
});

/**
 * 3b. POST /api/v1/spec/external
 * Explicitly push an external family spec from Agent/MCP to Web UI and store it.
 */
v1Router.post("/spec/external", (req, res) => {
  const spec = req.body?.spec;
  if (!spec || typeof spec !== "object") {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Field 'spec' is required",
      }),
    );
  }

  const analysis = analyzeSpec(spec);
  const specHash = computeSpecHash(spec);
  const record = setLatestExternalSpec({
    spec,
    specHash,
    analysis,
    warnings: analysis?.warnings || [],
  });

  res.json(
    makeEnvelope(req, true, {
      pushed: true,
      spec_hash: record.spec_hash,
      name: spec.name || "Family",
      updated_at: record.updated_at,
      geometry_summary: record.geometry_summary,
    }),
  );
});

/**
 * 3c. GET /api/v1/spec/external/latest
 * Read the latest external spec (used by Web UI polling or manual fetch)
 */
v1Router.get("/spec/external/latest", (req, res) => {
  const latest = getLatestExternalSpec();
  res.json(
    makeEnvelope(req, true, latest),
  );
});

/**
 * 3d. GET /api/v1/spec/external/stream
 * Server-Sent Events stream for instant real-time sync to Web UI
 */
v1Router.get("/spec/external/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const latest = getLatestExternalSpec();
  if (latest) {
    res.write(`data: ${JSON.stringify(latest)}\n\n`);
  }

  const unsubscribe = subscribeExternalSpec((data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * 4. POST /api/v1/build
 * Request build with approval check & idempotency
 */
v1Router.post("/build", async (req, res) => {
  const {
    spec,
    preview_id,
    spec_hash,
    approval_token,
    idempotency_key,
    output_policy = {},
    requester = "dg_app",
  } = req.body || {};

  if (!spec || typeof spec !== "object") {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Field 'spec' is required",
      }),
    );
  }

  const currentHash = computeSpecHash(spec);

  // If client passed a preview_id, verify that spec hasn't changed
  if (preview_id) {
    const preview = getPreview(preview_id);
    if (!preview) {
      return res.status(400).json(
        makeEnvelope(req, false, null, {
          code: "PREVIEW_STALE",
          message: "Preview ID not found or expired",
        }),
      );
    }
    if (preview.spec_hash !== currentHash) {
      return res.status(400).json(
        makeEnvelope(req, false, null, {
          code: "PREVIEW_STALE",
          message: "Spec has been modified since preview was generated",
          details: { expected_hash: preview.spec_hash, actual_hash: currentHash },
        }),
      );
    }
  }

  if (spec_hash && spec_hash !== currentHash) {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "spec_hash does not match the payload spec",
      }),
    );
  }

  // Validate Spec
  const analysis = analyzeSpec(spec);
  if (!analysis.ok) {
    return res.status(400).json(
      makeEnvelope(req, false, null, {
        code: "INVALID_SPEC",
        message: "Spec contains errors",
        details: { errors: analysis.errors },
      }),
    );
  }

  // Check Approval Token if configured
  const requiredApproval = process.env.REQUIRE_BUILD_APPROVAL === "1";
  if (requiredApproval && !approval_token) {
    return res.status(403).json(
      makeEnvelope(req, false, null, {
        code: "APPROVAL_REQUIRED",
        message: "Valid approval_token is required for write operation",
      }),
    );
  }

  // Create Job with Idempotency
  const { job, duplicate } = createJob({
    spec,
    previewId: preview_id,
    specHash: currentHash,
    idempotencyKey: idempotency_key,
    approved: true,
    outputPolicy: output_policy,
    requester,
  });

  if (duplicate) {
    return res.json(
      makeEnvelope(req, true, {
        job_id: job.job_id,
        status: job.status,
        duplicate: true,
        progress: job.progress,
        message: job.message,
        artifact_ref: job.artifact_ref,
      }),
    );
  }

  // Start background / async build
  executeJobAsync(job, analysis);

  // Return accepted response with job_id
  res.status(202).json(
    makeEnvelope(req, true, {
      job_id: job.job_id,
      status: job.status,
      message: job.message,
      progress: job.progress,
      created_at: job.created_at,
    }),
  );
});

/**
 * 5. GET /api/v1/jobs/:job_id
 * Job status & progress polling
 */
v1Router.get("/jobs/:job_id", (req, res) => {
  const jobId = req.params.job_id;
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json(
      makeEnvelope(req, false, null, {
        code: "JOB_NOT_FOUND",
        message: `Job '${jobId}' was not found`,
      }),
    );
  }

  res.json(
    makeEnvelope(req, true, {
      job_id: job.job_id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      created_at: job.created_at,
      updated_at: job.updated_at,
      artifact_ref: job.artifact_ref,
      diagnostics: job.diagnostics,
      error: job.error,
    }),
  );
});

/**
 * 6. GET /api/v1/jobs
 * List recent jobs
 */
v1Router.get("/jobs", (req, res) => {
  const list = listJobs({ limit: 50 });
  res.json(makeEnvelope(req, true, { jobs: list }));
});

/**
 * Background Executor for Jobs
 */
async function executeJobAsync(job, analysis) {
  const spec = analysis.spec;
  try {
    updateJob(job.job_id, {
      status: "running",
      progress: 20,
      message: "Verifying Revit bridge connection...",
    });

    const isConnected = await bridgeAlive();
    if (!isConnected) {
      updateJob(job.job_id, {
        status: "awaiting_revit",
        progress: 30,
        message: "Revit bridge is not connected. Job queued in awaiting_revit.",
        error: {
          code: "REVIT_UNAVAILABLE",
          message: "Revit bridge is not currently answering on " + config.bridge.url,
          retryable: true,
        },
      });
      return;
    }

    updateJob(job.job_id, {
      status: "running",
      progress: 50,
      message: "Revit is building native family...",
    });

    const result = await buildFamily(spec);

    if (result.ok) {
      const qa = auditBuild(analysis, result);
      updateJob(job.job_id, {
        status: "succeeded",
        progress: 100,
        message: "Native Family RFA built successfully",
        artifact_ref: {
          path: result.path,
          revit_version: result.revitVersion,
          stats: result.stats,
          qa,
          elapsed_ms: result.elapsedMs,
        },
        diagnostics: [...(result.warnings || []), ...(qa.warnings || [])],
      });
    } else {
      const isBusy = result.busy || result.mode === "queue";
      updateJob(job.job_id, {
        status: isBusy ? "awaiting_revit" : "failed",
        progress: isBusy ? 40 : 100,
        message: result.error || result.message || "Failed to build Revit family",
        error: {
          code: isBusy ? "JOB_CONFLICT" : "BUILD_FAILED",
          message: result.error || result.message || "Build failed",
          retryable: isBusy,
        },
      });
    }
  } catch (err) {
    updateJob(job.job_id, {
      status: "failed",
      progress: 100,
      message: err.message || "Unhandled error during family build",
      error: {
        code: "BUILD_FAILED",
        message: err.message,
        retryable: true,
      },
    });
  }
}
