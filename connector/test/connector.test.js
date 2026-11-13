import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RevitConnectorService } from "../src/index.js";

describe("Windows Revit Connector Service Tests", () => {
  const fakeConfig = {
    connectorId: "test-connector-01",
    cloudApiUrl: "http://localhost:8787",
    connectorToken: "token-123",
    pollIntervalMs: 100,
    maxConcurrentJobs: 1,
    revitBridgeUrl: "http://localhost:8765",
  };

  const fakeSpec = {
    name: "DN80 Gate Valve",
    category: "Pipe Accessories",
    parameters: [{ name: "L", type: "Length", value: 200 }],
    parts: [{ kind: "box", name: "Body", size: { x: 100, y: 100, z: 100 } }],
  };

  test("runs capabilities negotiation correctly", () => {
    const service = new RevitConnectorService(fakeConfig, {}, {});
    const caps = service.getCapabilities({ revitVersion: 2024, running: true });

    assert.equal(caps.connector_id, "test-connector-01");
    assert.equal(caps.revit_version, 2024);
    assert.equal(caps.revit_running, true);
    assert.equal(caps.native_forms_supported, true);
  });

  test("handles successful job processing flow", async () => {
    let progressReported = [];
    let completedJob = null;

    const mockRevitClient = {
      async checkHealth() {
        return { running: true, revitVersion: 2024 };
      },
      async build(spec) {
        return {
          success: true,
          rfaPath: null,
          revitVersion: 2024,
          stats: { partsBuilt: 1, nativeForms: 1, freeformCount: 0 },
          warnings: [],
        };
      },
    };

    const mockCloudClient = {
      async pollJob() {
        return { id: "job-101", spec: fakeSpec };
      },
      async updateProgress(id, data) {
        progressReported.push(data.stage);
      },
      async completeJob(id, res) {
        completedJob = { id, res };
      },
      async failJob() {},
    };

    const service = new RevitConnectorService(fakeConfig, mockRevitClient, mockCloudClient);
    const ran = await service.runOnce();

    assert.equal(ran, true);
    // Chờ async dispatch
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(completedJob?.id, "job-101");
    assert.equal(completedJob?.res?.status, "completed");
    assert.ok(progressReported.includes("validating_spec"));
    assert.ok(progressReported.includes("building_geometry_in_revit"));
  });

  test("handles Revit not running failure gracefully", async () => {
    let failedJob = null;

    const mockRevitClient = {
      async checkHealth() {
        return { running: false, revitVersion: 0 };
      },
    };

    const mockCloudClient = {
      async pollJob() {
        return { id: "job-102", spec: fakeSpec };
      },
      async updateProgress() {},
      async completeJob() {},
      async failJob(id, err) {
        failedJob = { id, err };
      },
    };

    const service = new RevitConnectorService(fakeConfig, mockRevitClient, mockCloudClient);
    await service.runOnce();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(failedJob?.id, "job-102");
    assert.ok(failedJob?.err?.message.includes("Autodesk Revit is not running"));
  });
});

