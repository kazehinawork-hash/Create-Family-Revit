import fs from "node:fs";
import path from "node:path";

/**
 * Client kết nối Outbound tới Cloud API.
 * Quản lý: Đăng ký thiết bị, Long-polling / Poll job, cập nhật tiến độ và hoàn thành job.
 */
export class CloudApiClient {
  constructor(config) {
    this.baseUrl = config.cloudApiUrl;
    this.token = config.connectorToken;
    this.connectorId = config.connectorId;
  }

  _headers() {
    return {
      "Content-Type": "application/json",
      "X-Connector-Id": this.connectorId,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /**
   * Khai báo Capabilities của Connector tới Cloud
   */
  async register(capabilities) {
    const res = await fetch(`${this.baseUrl}/api/v1/connector/register`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(capabilities),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Register failed (${res.status}): ${err}`);
    }
    return await res.json();
  }

  /**
   * Kéo (poll) job đang chờ từ Cloud Queue
   */
  async pollJob() {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/connector/jobs/poll`, {
        method: "GET",
        headers: this._headers(),
      });
      if (res.status === 204 || res.status === 404) {
        return null; // Không có job trong hàng đợi
      }
      if (!res.ok) {
        throw new Error(`Poll job failed with HTTP ${res.status}`);
      }
      const envelope = await res.json();
      return envelope.data || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Cập nhật tiến độ của job
   */
  async updateProgress(jobId, { stage, progress }) {
    await fetch(`${this.baseUrl}/api/v1/connector/jobs/${jobId}/progress`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ stage, progress }),
    }).catch(() => {});
  }

  /**
   * Báo cáo hoàn thành job kèm file RFA
   */
  async completeJob(jobId, buildResult, rfaBuffer = null) {
    let payload = { ...buildResult };

    if (rfaBuffer) {
      payload.rfa_base64 = rfaBuffer.toString("base64");
    }

    const res = await fetch(`${this.baseUrl}/api/v1/connector/jobs/${jobId}/complete`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Failed to complete job (${res.status})`);
    }
    return await res.json();
  }

  /**
   * Báo cáo lỗi khi dựng job
   */
  async failJob(jobId, error) {
    await fetch(`${this.baseUrl}/api/v1/connector/jobs/${jobId}/fail`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        error: {
          code: error.code || "BUILD_FAILED",
          message: error.message || String(error),
        },
      }),
    }).catch(() => {});
  }
}

