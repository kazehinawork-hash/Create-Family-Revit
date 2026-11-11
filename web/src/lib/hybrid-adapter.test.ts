import { describe, it, expect, vi } from "vitest";
import { HybridBuildAdapter } from "./hybrid-adapter.js";

describe("HybridBuildAdapter Tests", () => {
  const fakeSpec: any = {
    name: "Gate Valve DN100",
    category: "Generic Model",
    parameters: [],
    parts: [],
  };

  it("submits a job to cloud worker successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        data: {
          id: "job_cf_123",
          status: "queued",
          created_at: "2026-11-11T10:00:00Z",
        },
      }),
    });
    global.fetch = mockFetch;

    const adapter = new HybridBuildAdapter("https://api.cloud.test");
    const res = await adapter.submitCloudJob(fakeSpec);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.cloud.test/api/v1/jobs",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res.jobId).toBe("job_cf_123");
    expect(res.status).toBe("queued");
  });

  it("polls and waits for completion from connector", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            data: { id: "job_cf_123", status: "processing", progress: 50, stage: "building_geometry_in_revit" },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            id: "job_cf_123",
            status: "completed",
            progress: 100,
            result: {
              artifacts: { rfa_file_name: "Gate Valve DN100.rfa" },
            },
          },
        }),
      };
    });
    global.fetch = mockFetch;

    const adapter = new HybridBuildAdapter();
    const stages: string[] = [];
    const res = await adapter.waitForJobCompletion("job_cf_123", (_p, stage) => stages.push(stage), 5000, 10);

    expect(res.status).toBe("completed");
    expect(res.rfaFileName).toBe("Gate Valve DN100.rfa");
    expect(stages).toContain("building_geometry_in_revit");
  });
});

