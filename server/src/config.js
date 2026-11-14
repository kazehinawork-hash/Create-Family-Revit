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
  /** Loopback by default: the studio and the Revit bridge are local tools. */
  host: process.env.HOST || "127.0.0.1",
  allowedHosts: (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  agent: {
    provider: (process.env.AGENT_PROVIDER || "commandcode").toLowerCase(),
    command: process.env.COMMAND_CODE_BIN || "cmdc",
    codexBin: process.env.CODEX_BIN || "codex",
    claudeBin: process.env.CLAUDE_BIN || "claude",
    model: process.env.COMMAND_CODE_MODEL || "",
    effort: process.env.COMMAND_CODE_EFFORT || "",
    /**
     * Reasoning effort for build/repair turns. `low` keeps a heavy brief inside its
     * step budget; COMMAND_CODE_EFFORT (an explicit user choice) wins over it.
     */
    buildEffort: (process.env.AGENT_BUILD_EFFORT || "low").toLowerCase(),
    /** AGENT_CLI_SAFE_MODE=1 adds `--safe-mode` (built-in mods only). Off by default. */
    cliSafeMode: process.env.AGENT_CLI_SAFE_MODE === "1",
    /** AGENT_CLI_NO_SKILLS=0 keeps skill discovery on for CLI design runs. */
    cliNoSkills: process.env.AGENT_CLI_NO_SKILLS !== "0",
    /** Per model call. Kept for older callers; the step values below are the real budget. */
    timeoutMs: Number(process.env.AGENT_TIMEOUT || 240000),
    /** Skeleton pass of a new family (geometry + parameters). */
    // AGENT_TIMEOUT used to be ignored by design runs; it is now the fallback for
    // the per-step budget so one .env value controls how long a model may write.
    stepTimeoutMs: Number(process.env.AGENT_STEP_TIMEOUT || process.env.AGENT_TIMEOUT || 240000),
    /** Connector / material / edit passes. */
    editTimeoutMs: Number(process.env.AGENT_EDIT_TIMEOUT || 120000),
    /**
     * Hard ceiling for one model call. A heavy 5-section brief has been measured at
     * 5m46s on deepseek flash, so 5 minutes cut healthy runs; 8 minutes leaves room
     * while a hung call is still bounded and never retried on the same prompt.
     */
    maxTurnTimeoutMs: Number(process.env.AGENT_MAX_TURN_TIMEOUT || 480000),
    /** Whole request, all steps together (a split LOD 400 brief runs 4-5 passes). */
    totalTimeoutMs: Number(process.env.AGENT_TOTAL_TIMEOUT || 1500000),
    /** A new brief longer than this is split into skeleton + connectors + materials. */
    splitThreshold: Number(process.env.AGENT_SPLIT_THRESHOLD || 3000),
    /**
     * A brief with explicit "##" sections longer than this is built section by
     * section from the start. One giant answer times out on slow providers and the
     * timeout fallback would waste the whole first turn before splitting anyway.
     * AGENT_SECTION_SPLIT=0 turns the proactive split off.
     */
    sectionSplitMinChars: Number(process.env.AGENT_SECTION_SPLIT_MIN_CHARS || 2500),
    /** SSE keep-alive while a design run is in flight. */
    heartbeatMs: Number(process.env.DESIGN_HEARTBEAT_MS || 15000),
    /**
     * After the SSE socket drops, the design keeps running this long. If the studio
     * polls the job in the meantime (reload, proxy restart) it is not cancelled.
     */
    reconnectGraceMs: Number(process.env.AGENT_RECONNECT_GRACE_MS || 15000),
    /** Transient provider errors (429/5xx/overloaded) are retried this many times. */
    retryMax: Number(process.env.AGENT_RETRY_MAX || 3),
    /** 2000 ms base -> 2 s, 5 s, 12 s with the default schedule. */
    retryBaseMs: Number(process.env.AGENT_RETRY_BASE_MS || 2000),
    /**
     * Per-turn budgets of the stable pipeline. Each kind of extra call has its own
     * budget so a timeout or a supplement round never eats the repair turns.
     * Counts are EXTRA calls after the first one.
     */
    repairMax: Number(process.env.AGENT_REPAIR_MAX || 2),
    supplementMax: Number(process.env.AGENT_SUPPLEMENT_MAX || 2),
    layoutMax: Number(process.env.AGENT_LAYOUT_MAX || 1),
    proseMax: Number(process.env.AGENT_PROSE_MAX || 1),
    timeoutRetryMax: Number(process.env.AGENT_TIMEOUT_RETRY_MAX || 1),
    /** Hard ceiling of model calls in one turn, whatever the budgets above say. */
    turnCallsMax: Number(process.env.AGENT_TURN_CALLS_MAX || 6),
    /**
     * The whole request is retried after these waits when the provider is overloaded
     * before any spec exists (a 503 burst lasts minutes, not seconds).
     */
    requestRetryDelays: (process.env.AGENT_REQUEST_RETRY_DELAYS || "20000,45000")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0),
    /** Explicit fallback chain; empty = derive from the available CLI models. */
    fallbackModels: (process.env.AGENT_FALLBACK_MODELS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    /** Tier routing. Empty = cheapest / medium / strongest model this machine can run. */
    tier1Model: process.env.AGENT_TIER1_MODEL || "",
    tier2Model: process.env.AGENT_TIER2_MODEL || "",
    tier3Model: process.env.AGENT_TIER3_MODEL || "",
    /** Prompt size caps per tier (characters). */
    promptMaxTier1: Number(process.env.AGENT_PROMPT_MAX_TIER1 || 12000),
    promptMaxTier2: Number(process.env.AGENT_PROMPT_MAX_TIER2 || 26000),
    promptMaxTier3: Number(process.env.AGENT_PROMPT_MAX_TIER3 || 40000),
    /** Cable-ladder templates (tee/elbow/cross) drawn locally instead of by a model. */
    useTemplates: process.env.AGENT_TEMPLATE !== "0",
    /**
     * Off (default): the stable c709e4c pipeline — one model, one conversation, up to
     * three repairs. On: templates, tier routing, checklist supplement rounds, vision
     * evidence, rule packs and plausibility repairs run again for comparison.
     * Read lazily so a test can flip it without re-importing the config.
     */
    get experimentalPipeline() {
      return process.env.AGENT_EXPERIMENTAL_PIPELINE === "1";
    },
    /** Direct-API vision model used to read photos/catalogue pages. */
    visionModel: process.env.AGENT_VISION_MODEL || "",
    /** Models this app treats as vision-capable direct APIs. */
    visionModels: (process.env.VISION_MODELS || "gpt-4o,gpt-4.1,gpt-5,claude-3-7-sonnet,claude-4,gemini-2.5-flash,gemini-2.5-pro")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  },
  llm: {
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o",
    temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
    maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 8000),
    /** Direct API streams tokens; a socket with no new token for this long is dead. */
    streamIdleMs: Number(process.env.AGENT_STREAM_IDLE_MS || 90000),
  },
  bridge: {
    url: (process.env.REVIT_BRIDGE_URL || "http://127.0.0.1:8765").replace(/\/+$/, ""),
    timeoutMs: Number(process.env.REVIT_BRIDGE_TIMEOUT || 300000),
    // Optional shared secret. Must match FAMILY_AGENT_TOKEN in the Revit process.
    token: process.env.REVIT_BRIDGE_TOKEN || "",
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
    saved: process.env.FAMILY_SAVED_DIR || path.join(ROOT, "saved-models"),
    out: process.env.FAMILY_OUT_DIR || path.join(home, "Documents", "FamilyAgent", "out"),
    queue: process.env.FAMILY_QUEUE_DIR || path.join(home, "Documents", "FamilyAgent", "queue"),
    rules: process.env.FAMILY_RULES_DIR || path.join(ROOT, "server", "rules"),
  },
};
