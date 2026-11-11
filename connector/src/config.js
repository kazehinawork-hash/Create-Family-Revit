import os from "node:os";

export function loadConnectorConfig() {
  return {
    connectorId: process.env.CONNECTOR_ID || `win-connector-${os.hostname()}`,
    cloudApiUrl: (process.env.CLOUD_API_URL || "https://api.family-agent.com").replace(/\/+$/, ""),
    connectorToken: process.env.CONNECTOR_TOKEN || "",
    pollIntervalMs: Number(process.env.CONNECTOR_POLL_INTERVAL_MS || 3000),
    maxConcurrentJobs: Number(process.env.CONNECTOR_MAX_CONCURRENT || 1),
    revitBridgeUrl: (process.env.REVIT_BRIDGE_URL || "http://127.0.0.1:8765").replace(/\/+$/, ""),
    revitBridgeTimeoutMs: Number(process.env.REVIT_BRIDGE_TIMEOUT_MS || 300000),
    bridgeToken: process.env.REVIT_BRIDGE_TOKEN || "",
    outDir: process.env.FAMILY_OUT_DIR || null,
  };
}

