import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { writeJsonAtomic } from "./files.js";

/**
 * Shared In-Memory & File-Backed Job Store for DG app integration
 * State Machine: queued -> running -> succeeded | failed | cancelled
 * With awaiting_revit if Revit is not connected or busy.
 */

const jobs = new Map();
const previews = new Map();
const idempotencyKeys = new Map();

export const JOBS_DIR = path.join(config.dirs.root, ".jobs");

export function computeSpecHash(spec) {
  const normalized = JSON.stringify(spec);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function savePreview({ spec, specHash, analysis, warnings = [] }) {
  const previewId = "prev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date().toISOString();

  const previewData = {
    preview_id: previewId,
    spec_hash: specHash,
    spec,
    created_at: now,
    geometry_summary: {
      bounds: analysis.model?.bounds || null,
      parts_count: analysis.model?.parts?.length || 0,
      parameters_count: spec.parameters?.length || 0,
      connectors_count: spec.connectors?.length || 0,
    },
    warnings,
  };

  previews.set(previewId, previewData);
  return previewData;
}

export function getPreview(previewId) {
  return previews.get(previewId) || null;
}

export function createJob({
  spec,
  previewId,
  specHash,
  idempotencyKey,
  approved = true,
  outputPolicy = {},
  requester = "dg_app",
}) {
  if (idempotencyKey && idempotencyKeys.has(idempotencyKey)) {
    const existingJobId = idempotencyKeys.get(idempotencyKey);
    const existingJob = getJob(existingJobId);
    if (existingJob) {
      return { job: existingJob, duplicate: true };
    }
  }

  const jobId = "job_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date().toISOString();

  const job = {
    job_id: jobId,
    status: "queued", // queued | awaiting_revit | running | succeeded | failed | cancelled
    preview_id: previewId || null,
    spec_hash: specHash,
    idempotency_key: idempotencyKey || null,
    approved: Boolean(approved),
    output_policy: outputPolicy,
    requester,
    spec,
    created_at: now,
    updated_at: now,
    progress: 0,
    message: "Job queued for Revit build",
    diagnostics: [],
    artifact_ref: null,
    error: null,
  };

  jobs.set(jobId, job);
  if (idempotencyKey) {
    idempotencyKeys.set(idempotencyKey, jobId);
  }

  persistJob(job);
  return { job, duplicate: false };
}

export function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return null;

  Object.assign(job, updates, { updated_at: new Date().toISOString() });
  persistJob(job);
  return job;
}

export function getJob(jobId) {
  if (jobs.has(jobId)) {
    return jobs.get(jobId);
  }

  // Fallback to disk
  try {
    const filePath = path.join(JOBS_DIR, `${jobId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      jobs.set(jobId, data);
      return data;
    }
  } catch {}

  return null;
}

export function listJobs({ limit = 20 } = {}) {
  return Array.from(jobs.values())
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}

function persistJob(job) {
  try {
    if (!fs.existsSync(JOBS_DIR)) {
      fs.mkdirSync(JOBS_DIR, { recursive: true });
    }
    const filePath = path.join(JOBS_DIR, `${job.job_id}.json`);
    writeJsonAtomic(filePath, job);
  } catch (err) {
    console.warn(`[Jobs] Failed to persist job ${job.job_id}:`, err.message);
  }
}

