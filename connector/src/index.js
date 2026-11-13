import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConnectorConfig } from "./config.js";
import { LocalRevitClient } from "./revit-client.js";
import { CloudApiClient } from "./cloud-client.js";

/**
 * Service chính của Windows Revit Connector:
 * Vòng lặp Outbound polling nhận job, điều phối tới Revit Add-in, gửi kết quả về Cloud.
 */
export class RevitConnectorService {
  constructor(config = loadConnectorConfig(), revitClient = null, cloudClient = null) {
    this.config = config;
    this.revitClient = revitClient || new LocalRevitClient(config);
    this.cloudClient = cloudClient || new CloudApiClient(config);
    this.running = false;
    this.activeJobs = new Set();
  }

  getCapabilities(revitHealth) {
    return {
      connector_id: this.config.connectorId,
      revit_version: revitHealth.revitVersion || 2024,
      revit_running: revitHealth.running,
      supported_categories: [
        "Pipe Accessories",
        "Pipe Fittings",
        "Mechanical Equipment",
        "Duct Accessories",
        "Generic Models",
      ],
      native_forms_supported: true,
      max_concurrent_jobs: this.config.maxConcurrentJobs,
      os: `${os.type()} ${os.release()}`,
      version: "1.0.0",
    };
  }

  async processJob(job) {
    const jobId = job.job_id || job.id;
    if (this.activeJobs.has(jobId)) return;
    this.activeJobs.add(jobId);

    const startedAt = Date.now();
    try {
      await this.cloudClient.updateProgress(jobId, {
        stage: "validating_spec",
        progress: 10,
      });

      // 1. Kiểm tra Revit sẵn sàng
      const health = await this.revitClient.checkHealth();
      if (!health.running) {
        throw new Error("Autodesk Revit is not running or Add-in bridge is unavailable.");
      }

      await this.cloudClient.updateProgress(jobId, {
        stage: "building_geometry_in_revit",
        progress: 30,
      });

      // 2. Gọi Revit build RFA
      const buildRes = await this.revitClient.build(job.spec);

      await this.cloudClient.updateProgress(jobId, {
        stage: "uploading_rfa",
        progress: 80,
      });

      // 3. Đọc file RFA để upload
      let rfaBuffer = null;
      let rfaSize = 0;
      if (buildRes.rfaPath && fs.existsSync(buildRes.rfaPath)) {
        rfaBuffer = fs.readFileSync(buildRes.rfaPath);
        rfaSize = rfaBuffer.length;
      }

      const durationMs = Date.now() - startedAt;
      const result = {
        job_id: jobId,
        status: "completed",
        progress: 100,
        artifacts: {
          rfa_file_name: path.basename(buildRes.rfaPath || `${job.spec.name || "Family"}.rfa`),
          rfa_size_bytes: rfaSize,
        },
        metrics: {
          duration_ms: durationMs,
          parts_built: buildRes.stats?.partsBuilt || job.spec.parts?.length || 0,
          native_forms: buildRes.stats?.nativeForms || 0,
          freeform_count: buildRes.stats?.freeformCount || 0,
        },
        warnings: buildRes.warnings || [],
        updated_at: new Date().toISOString(),
      };

      await this.cloudClient.completeJob(jobId, result, rfaBuffer);
    } catch (err) {
      await this.cloudClient.failJob(jobId, err);
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  async runOnce() {
    if (this.activeJobs.size >= this.config.maxConcurrentJobs) {
      return false;
    }

    const job = await this.cloudClient.pollJob();
    if (job) {
      void this.processJob(job);
      return true;
    }
    return false;
  }

  async start() {
    this.running = true;
    const health = await this.revitClient.checkHealth();
    await this.cloudClient.register(this.getCapabilities(health)).catch(() => {});

    while (this.running) {
      try {
        await this.runOnce();
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}

if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const service = new RevitConnectorService();
  service.start().catch((err) => {
    process.exit(1);
  });
}

