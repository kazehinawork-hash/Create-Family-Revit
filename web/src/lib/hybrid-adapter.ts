/**
 * Hybrid Client Adapter for Web Studio.
 * Cho phép Web Studio hoạt động linh hoạt:
 * - Local Mode: gọi trực tiếp /api/build hoặc /api/v1/build của Local Express
 * - Hybrid Web Mode: submit job lên Cloudflare Worker (/api/v1/jobs) và poll kết quả từ Windows Revit Connector
 */

import type { FamilySpec } from "@family/spec-core";

export interface CloudJobSubmitResult {
  jobId: string;
  status: "queued" | "assigned" | "processing" | "completed" | "failed";
  createdAt: string;
}

export interface CloudJobPollResult {
  jobId: string;
  status: "queued" | "assigned" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  stage?: string;
  rfaUrl?: string;
  rfaFileName?: string;
  error?: string;
}

export class HybridBuildAdapter {
  constructor(private cloudBaseUrl: string = "") {}

  /**
   * Submit Family Spec lên Cloudflare Worker Job Queue
   */
  async submitCloudJob(spec: FamilySpec, options = {}): Promise<CloudJobSubmitResult> {
    const url = `${this.cloudBaseUrl}/api/v1/jobs`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec, options }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message || `Failed to submit cloud job (HTTP ${res.status})`);
    }

    return {
      jobId: body.data.id,
      status: body.data.status,
      createdAt: body.data.created_at,
    };
  }

  /**
   * Tra cứu trạng thái tiến độ job từ xa
   */
  async pollCloudJob(jobId: string): Promise<CloudJobPollResult> {
    const url = `${this.cloudBaseUrl}/api/v1/jobs/${jobId}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message || `Failed to poll job status (HTTP ${res.status})`);
    }

    const job = body.data;
    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress || 0,
      stage: job.stage,
      rfaUrl: job.result?.artifacts?.rfa_url,
      rfaFileName: job.result?.artifacts?.rfa_file_name,
      error: job.result?.error?.message,
    };
  }

  /**
   * Chờ job hoàn thành có timeout và polling
   */
  async waitForJobCompletion(
    jobId: string,
    onProgress?: (progress: number, stage: string) => void,
    timeoutMs = 300000,
    intervalMs = 2000,
  ): Promise<CloudJobPollResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.pollCloudJob(jobId);
      if (onProgress) {
        onProgress(result.progress, result.stage || "");
      }
      if (result.status === "completed") {
        return result;
      }
      if (result.status === "failed" || result.status === "cancelled") {
        throw new Error(result.error || `Job failed with status ${result.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timeout waiting for Revit Connector to complete job ${jobId}`);
  }
}

export const hybridBuildAdapter = new HybridBuildAdapter();

