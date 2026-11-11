import { describe, it, expect } from "vitest";
import {
  createEnvelope,
  type FamilyBuildRequest,
  type _FamilyBuildResult,
  type BuilderCapabilities,
} from "../src/contracts.js";

describe("Shared Contracts & Envelope Tests", () => {
  it("creates a compliant successful ApiEnvelope", () => {
    const envelope = createEnvelope(true, { message: "ok" }, null, { request_id: "req-123" });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ message: "ok" });
    expect(envelope.error).toBeNull();
    expect(envelope.meta.request_id).toBe("req-123");
    expect(envelope.meta.server_time).toBeDefined();
    expect(envelope.meta.version).toBe("1.0.0");
  });

  it("creates a compliant error ApiEnvelope", () => {
    const envelope = createEnvelope(false, null, {
      code: "INVALID_SPEC",
      message: "Spec missing name",
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.error?.code).toBe("INVALID_SPEC");
    expect(envelope.error?.message).toBe("Spec missing name");
  });

  it("validates FamilyBuildRequest structure", () => {
    const request: FamilyBuildRequest = {
      job_id: "job_01",
      spec_hash: "hash_abc",
      spec: {
        name: "Test Valve",
        category: "Pipe Accessories",
        parameters: [],
        parts: [],
      },
      created_at: new Date().toISOString(),
    };
    expect(request.job_id).toBe("job_01");
    expect(request.spec.name).toBe("Test Valve");
  });

  it("validates BuilderCapabilities structure", () => {
    const caps: BuilderCapabilities = {
      connector_id: "win-builder-01",
      revit_version: 2024,
      revit_running: true,
      supported_categories: ["Pipe Accessories", "Mechanical Equipment"],
      native_forms_supported: true,
      max_concurrent_jobs: 1,
      os: "Windows 11 Pro",
      version: "1.0.0",
    };
    expect(caps.revit_version).toBe(2024);
    expect(caps.native_forms_supported).toBe(true);
  });
});

