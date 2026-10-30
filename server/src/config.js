import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env"));

const home = os.homedir();

export const config = {
  port: Number(process.env.PORT || 8787),
  agent: {
    provider: (process.env.AGENT_PROVIDER || "commandcode").toLowerCase(),
    command: process.env.COMMAND_CODE_BIN || "cmdc",
    codexBin: process.env.CODEX_BIN || "codex",
    claudeBin: process.env.CLAUDE_BIN || "claude",
    model: process.env.COMMAND_CODE_MODEL || "",
    effort: process.env.COMMAND_CODE_EFFORT || "",
    timeoutMs: Number(process.env.AGENT_TIMEOUT || 600000),
  },
  llm: {
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o",
    temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
    maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 8000),
  },
  bridge: {
    url: (process.env.REVIT_BRIDGE_URL || "http://127.0.0.1:8765").replace(/\/+$/, ""),
    timeoutMs: Number(process.env.REVIT_BRIDGE_TIMEOUT || 300000),
  },
  revit: {
    exe: process.env.REVIT_EXE || "",
    version: process.env.REVIT_VERSION || "2024",
    autoStart: process.env.REVIT_AUTO_START !== "0",
    startTimeoutMs: Number(process.env.REVIT_START_TIMEOUT || 240000),
  },
  dirs: {
    root: ROOT,
    webDist: path.join(ROOT, "web", "dist"),
    prompts: path.join(ROOT, "server", "prompts"),
    uploads: path.join(ROOT, ".uploads"),
    saved: path.join(ROOT, "saved-models"),
    out: process.env.FAMILY_OUT_DIR || path.join(home, "Documents", "FamilyAgent", "out"),
    queue: process.env.FAMILY_QUEUE_DIR || path.join(home, "Documents", "FamilyAgent", "queue"),
  },
};
