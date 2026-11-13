import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateSpec } from "@family/spec-core";

/**
 * Client giao tiếp với Revit Add-in cục bộ (chạy trên localhost).
 */
export class LocalRevitClient {
  constructor(config) {
    this.bridgeUrl = config.revitBridgeUrl;
    this.timeoutMs = config.revitBridgeTimeoutMs || 300000;
    this.bridgeToken = config.bridgeToken || "";
  }

  /**
   * Kiểm tra khả năng kết nối tới Revit Add-in Bridge
   */
  async checkHealth() {
    try {
      const res = await fetch(`${this.bridgeUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return {
          available: true,
          revitVersion: data.revitVersion || 2024,
          running: true,
        };
      }
    } catch {
      // Bridge không phản hồi
    }
    return {
      available: false,
      revitVersion: 0,
      running: false,
    };
  }

  /**
   * Gửi yêu cầu dựng Family Spec tới Revit Add-in
   */
  async build(spec) {
    // 1. Validate spec trước khi gửi vào Revit
    const val = validateSpec(spec);
    if (!val.ok) {
      throw new Error(`Invalid Family Spec: ${val.errors.map((e) => e.message).join(", ")}`);
    }

    // 2. Gửi qua HTTP Bridge tới Revit Add-in
    const res = await fetch(`${this.bridgeUrl}/build`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.bridgeToken ? { "X-Family-Token": this.bridgeToken } : {}),
      },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const errMsg = body.error || `Revit Bridge error HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    return {
      success: true,
      rfaPath: body.path,
      revitVersion: body.revitVersion,
      stats: body.stats || {},
      warnings: body.warnings || [],
    };
  }
}

