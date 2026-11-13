/**
 * Shared API and Job Contracts for Local Mode, Cloudflare Web, and Windows Connector.
 */

import type { FamilySpec } from "./types.js";

export type JobStatus =
  | "queued"
  | "assigned"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface BuilderCapabilities {
  connector_id: string;
  revit_version: number;
  revit_running: boolean;
  supported_categories: string[];
  native_forms_supported: boolean;
  max_concurrent_jobs: number;
  os: string;
  version: string;
}

export interface FamilyBuildOptions {
  lod?: 200 | 300 | 350 | 400;
  native_only?: boolean;
  timeout_seconds?: number;
  author?: string;
}

export interface FamilyBuildRequest {
  job_id: string;
  project_id?: string;
  user_id?: string;
  spec_hash: string;
  spec: FamilySpec;
  options?: FamilyBuildOptions;
  idempotency_key?: string;
  created_at: string;
}

export interface FamilyBuildArtifacts {
  rfa_url?: string;
  rfa_file_name?: string;
  rfa_size_bytes?: number;
  local_path?: string;
}

export interface FamilyBuildMetrics {
  duration_ms: number;
  parts_built: number;
  native_forms: number;
  freeform_count: number;
  bounds?: { x: number; y: number; z: number };
}

export interface FamilyBuildResult {
  job_id: string;
  status: JobStatus;
  progress?: number;
  stage?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  artifacts?: FamilyBuildArtifacts;
  metrics?: FamilyBuildMetrics;
  warnings?: string[];
  updated_at: string;
}

export interface CloudJobRecord {
  id: string;
  user_id: string;
  project_id: string;
  status: JobStatus;
  assigned_connector_id?: string | null;
  spec_hash: string;
  spec: FamilySpec;
  options: FamilyBuildOptions;
  idempotency_key?: string | null;
  lease_expires_at?: string | null;
  result?: FamilyBuildResult | null;
  created_at: string;
  updated_at: string;
}

/**
 * Standard API Envelope used across Local Express & Cloudflare Workers
 */
export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: {
    code: string;
    message: string;
    details?: unknown;
  } | null;
  meta: {
    server_time: string;
    request_id?: string;
    version?: string;
  };
}

export function createEnvelope<T>(
  ok: boolean,
  data: T | null = null,
  error: { code: string; message: string; details?: unknown } | null = null,
  meta: Partial<ApiEnvelope["meta"]> = {},
): ApiEnvelope<T> {
  return {
    ok,
    data,
    error,
    meta: {
      server_time: new Date().toISOString(),
      version: "1.0.0",
      ...meta,
    },
  };
}

