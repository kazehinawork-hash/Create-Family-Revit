import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { LlmError, chatJson as openAiChatJson, dispatchCustomApi, parseModelJson } from "./llm.js";
import { runWithModelFallback } from "./retry.js";

/**
 * Antigravity CLI (agy) always writes a conversation entry, even in --print mode;
 * it has no --no-session flag. These entries are disposable agent jobs, not user
 * conversations, so purge the ones created from our temporary workspaces.
 */
async function pruneAgySessions() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const root = path.join(os.homedir(), ".gemini", "antigravity-cli");
    const dbPath = path.join(root, "conversation_summaries.db");
    if (!fs.existsSync(dbPath)) return;

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db
        .prepare(
          "SELECT conversation_id FROM conversation_summaries " +
            "WHERE preview LIKE 'You are Family Agent%' " +
            "AND (workspace_uris LIKE '%/Temp%' OR workspace_uris LIKE '%family-agent%')",
        )
        .all();

      for (const row of rows) {
        const id = String(row.conversation_id || "");
        if (!/^[a-f0-9-]{36}$/i.test(id)) continue;
        try {
          try {
            db.prepare("DELETE FROM conversations_fts WHERE conversation_id = ?").run(id);
          } catch {
            /* older Antigravity builds may not have the FTS table */
          }
          db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(id);
          fs.rmSync(path.join(root, "brain", id), { recursive: true, force: true });
          fs.rmSync(path.join(root, "conversations", `${id}.db`), { force: true });
        } catch {
          /* a live agy process may still hold this entry */
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn("[agy] session cleanup skipped:", error.message);
  }
}

function flatten(messages) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const turns = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role === "assistant" ? "ASSISTANT" : "USER"}:\n${message.content}`)
    .join("\n\n---\n\n");

  return `${system}\n\n---\n\n${turns}\n\nCRITICAL OUTPUT REQUIREMENT:\n- Return ONLY a single raw JSON object representing the complete spec.\n- Do NOT write conversational explanations, markdown notes, or preface text before or after the JSON.\n- Ensure all quotes and brackets inside string expressions (e.g. "[Casing Length] / 2") are properly closed and valid JSON.`;
}

function extractResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const frame = JSON.parse(lines[index]);
      if (frame && frame.type === "result") return frame;
    } catch {
      /* not a JSON frame */
    }
  }
  return null;
}

/**
 * Last-resort answer lookup when the CLI printed no `result` frame. stdout is a
 * stream of one-JSON-per-line frames, so a greedy /\{.*\}/ grabs garbage spanning
 * many frames. Walk the lines from the end instead and take the first one that is
 * either a spec or a frame carrying the final text.
 */
export function extractAnswerText(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value.parts) || typeof value.schemaVersion === "string") return line;
    for (const key of ["finalText", "response", "text", "content"]) {
      if (typeof value[key] === "string" && value[key].includes("{")) return value[key].trim();
    }
  }
  // A plain (non-framed) answer: the whole stdout is the JSON object. Two frames on
  // separate lines also start with { and end with }, so require a single line.
  const whole = String(stdout ?? "").trim();
  if (whole.startsWith("{") && whole.endsWith("}") && !whole.includes("\n")) return whole;
  return "";
}

/**
 * Only a token cap truncates the answer. The CLI also reports "Reached maximum
 * conversation turns" — that is a turn budget, not a long output, and the two need
 * different fixes (raise the turns vs split the brief).
 */
export function isTruncatedFrame(frame, stderr = "") {
  const stop = String(frame?.stopReason ?? frame?.stop_reason ?? "").toLowerCase();
  if (/max_tokens|output_limit|length/.test(stop)) return true;
  return /max(imum)? output tokens|output token limit/i.test(String(stderr ?? ""));
}

/** The CLI ran out of conversation turns before writing the answer. */
export function isMaxTurnsFrame(frame, stderr = "") {
  const stop = String(frame?.stopReason ?? frame?.stop_reason ?? "").toLowerCase();
  if (stop === "max_turns") return true;
  return /reached maximum conversation turns/i.test(String(stderr ?? ""));
}

export function maxTurnsError(maxTurns) {
  const error = new LlmError(
    `Model dùng hết ${maxTurns ? `${maxTurns} ` : ""}lượt của CLI mà chưa trả spec (MAX_TURNS).`,
  );
  error.code = "MAX_TURNS";
  return error;
}

export function outputLimitError(outputTokens) {
  const size = Number.isFinite(Number(outputTokens)) && outputTokens
    ? `${Number(outputTokens).toLocaleString("en-US")} token`
    : "giới hạn token";
  const error = new LlmError(
    `Model viết quá dài (${size}) mà chưa xong spec — yêu cầu cần được chia nhỏ (OUTPUT_LIMIT).`,
  );
  error.code = "OUTPUT_LIMIT";
  return error;
}

function describeEvent(event) {
  if (event.event === "step_update" || event.step_type) {
    const st = event.step_type || event.step_update?.step_type;
    if (st === "thinking") return "Thinking";
    if (st === "call_tool" || st === "tool_call") return "Consulting tools";
    if (st === "planner_response" || st === "message") return "Writing the spec";
  }

  // Codex JSON stream events
  if (event.type === "turn.started" || event.type === "thread.started") {
    return "Starting agent session";
  }
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return "Writing the spec";
  }

  switch (event.type) {
    case "tool_running":
      if (event.toolName === "read_file") return "Reading the document";
      return event.description
        ? `${event.toolName}: ${event.description}`.slice(0, 90)
        : `Using ${event.toolName}`;
    case "thinking_start":
      return "Thinking";
    case "turn_start":
      return event.turnNumber > 1 ? `Pass ${event.turnNumber}` : null;
    case "message_end":
      return "Writing the spec";
    default:
      return null;
  }
}

const IS_WINDOWS = process.platform === "win32";
const MAX_STDOUT_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 256 * 1024;
const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_LISTING_CHARS = 4 * 1024 * 1024;

/**
 * Keep only the newest text. Agent result frames are emitted at the end of stdout,
 * so dropping the oldest output preserves the useful part while keeping memory bounded.
 */
function keepTail(current, text, limit) {
  if (!text) return current;
  if (text.length >= limit) return text.slice(text.length - limit);
  const overflow = current.length + text.length - limit;
  return overflow > 0 ? current.slice(overflow) + text : current + text;
}

/**
 * npm-installed CLIs (`cmdc`, `codex`, `claude`) are `.cmd` shims on Windows, which
 * CreateProcess cannot start directly — they have to go through the shell.
 */
function spawnCli(executable, args, options = {}) {
  if (!IS_WINDOWS) return spawn(executable, args, options);
  // Join into one command string: passing an args array together with `shell` is
  // deprecated in Node because the arguments are not escaped for cmd.exe.
  const command = [executable, ...args]
    .map((part) => {
      const text = String(part);
      return /\s/.test(text) ? `"${text}"` : text;
    })
    .join(" ");
  return spawn(command, { ...options, shell: true });
}

/** Model ids come from CLI listings/config; strip anything shell-hostile. */
function safeArg(value) {
  return String(value ?? "").replace(/[^\w./:@+-]/g, "");
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;

  if (process.platform === "win32") {
    const windowsKill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    windowsKill.on("error", () => {});
    return;
  }

  try { child.kill("SIGTERM"); } catch { /* ignore */ }

  // A wedged CLI can ignore SIGTERM; without a hard kill the run would hold the
  // model slot (and the studio connection) until the step timeout expires.
  const hardKill = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }, 5000);
  hardKill.unref?.();
}

// The model a CLI run actually used. `cmdc` silently falls back to its default
// model when the requested id is unknown, so the reported model can differ from
// the one the user picked.
function extractUsedModel(stdout) {
  if (!stdout) return null;

  let model = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("model")) continue;
    try {
      const frame = JSON.parse(trimmed);
      const candidate = frame?.event?.model ?? frame?.model;
      if (typeof candidate === "string" && candidate.trim()) model = candidate.trim();
    } catch {
      /* partial line */
    }
  }
  return model;
}

function attachModel(error, model) {
  if (error && model && !error.model) error.model = model;
  return error;
}

/**
 * Shared lifecycle for every CLI backend: spawn, stream JSON progress, timeout,
 * abort, kill the process tree and collect stdout/stderr. The three backends used to
 * carry three near-identical copies of this ~100 line block.
 */
/**
 * The CLI reads COMMAND_CODE_API_KEY at startup, so a key pasted in the studio works
 * without `cmd login`. Never written to disk or logged.
 */
export function cliEnvFor(apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!key) return undefined;
  return { ...process.env, COMMAND_CODE_API_KEY: key };
}

function runCliProcess({
  tag,
  executable,
  args,
  prompt,
  cwd,
  timeoutMs,
  signal,
  onProgress,
  onStdoutLine,
  env,
}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    console.log(
      `[agent${tag}] spawn ${executable} cwd=${cwd || os.tmpdir()} prompt=${prompt.length}B`,
    );

    let child;
    try {
      // Tests replace the process outright; a real CLI must never be spawned then.
      child = spawnOverride
        ? spawnOverride(executable, args, { cwd, env })
        : spawnCli(executable, args, {
            cwd: cwd || os.tmpdir(),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            ...(env ? { env } : {}),
          });
    } catch (error) {
      reject(new LlmError(`Failed to spawn "${executable}": ${error.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let buffer = "";
    let lastModel = null;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lineTruncated = false;
    let settled = false;
    let timer = null;
    let onAbort = null;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      callback();
    };

    const fail = (message) => {
      finish(() => {
        killTree(child);
        reject(attachModel(new LlmError(message), lastModel));
      });
    };

    timer = setTimeout(() => {
      console.warn(`[agent${tag}] timeout after ${timeoutMs}ms`);
      fail(`Agent run timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    onAbort = () => {
      console.log(`[agent${tag}] aborted by user`);
      fail("Agent run was cancelled");
    };

    if (signal) {
      if (signal.aborted) {
        fail("Agent run was cancelled");
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (stdout.length + text.length > MAX_STDOUT_CHARS) stdoutTruncated = true;
      stdout = keepTail(stdout, text, MAX_STDOUT_CHARS);

      if (buffer.length + text.length > MAX_LINE_CHARS) lineTruncated = true;
      buffer = keepTail(buffer, text, MAX_LINE_CHARS);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let frame;
        try {
          frame = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const model = frame?.event?.model ?? frame?.model;
        if (typeof model === "string" && model.trim()) lastModel = model.trim();
        onStdoutLine?.(frame);
      }

      if (!onStdoutLine && onProgress) onProgress("Writing the spec");
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (stderr.length + text.length > MAX_STDERR_CHARS) stderrTruncated = true;
      stderr = keepTail(stderr, text, MAX_STDERR_CHARS);
    });

    const onPipeError = (name) => (error) => {
      if (["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes(error?.code)) return;
      console.error(`[agent${tag}] ${name} error:`, error);
    };
    child.stdin.on("error", onPipeError("stdin"));
    child.stdout.on("error", onPipeError("stdout"));
    child.stderr.on("error", onPipeError("stderr"));

    child.on("error", (error) => {
      console.error(`[agent${tag}] spawn error: ${error.message}`);
      finish(() => reject(new LlmError(`Could not run "${executable}": ${error.message}`)));
    });

    child.on("close", (code) => {
      console.log(
        `[agent${tag}] exit ${code} in ${Math.round((Date.now() - started) / 1000)}s ` +
          `stdout=${stdout.length}B stderr=${stderr.length}B`,
      );
      if (stdoutTruncated || stderrTruncated || lineTruncated) {
        console.warn(
          `[agent${tag}] output capped` +
            `${stdoutTruncated ? " stdout" : ""}` +
            `${stderrTruncated ? " stderr" : ""}` +
            `${lineTruncated ? " line" : ""}`,
        );
      }
      if (stderr.trim()) console.log(`[agent${tag}] stderr: ${stderr.trim().slice(-600)}`);
      finish(() => resolve({ code: code ?? 0, stdout, stderr, model: lastModel }));
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      finish(() =>
        reject(new LlmError(`Could not send prompt to "${executable}": ${error.message}`)),
      );
    }
  });
}

/** Effort levels the CLI understands, cheapest first. */
export const CLI_EFFORTS = ["off", "low", "medium", "high", "max"];

/**
 * Which reasoning effort a CLI design run uses. An explicit COMMAND_CODE_EFFORT is the
 * user's choice and wins; otherwise build/repair turns use the cheap default.
 */
export function resolveCliEffort({ effort, buildEffort } = {}) {
  const explicit = String(effort ?? config.agent.effort ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  const build = String(buildEffort ?? config.agent.buildEffort ?? "").trim().toLowerCase();
  return build;
}

/** Args shared by every cmdc design turn. */
export function commandCodeArgs({ maxTurns, model, effort } = {}) {
  const args = ["-p", "--no-session", "--output-format", "json", "--skip-onboarding", "--max-turns", String(maxTurns)];

  // Skills and mods are project automation, useless for writing one JSON spec and
  // expensive to discover on every call.
  if (config.agent.cliNoSkills) args.push("--no-skills");
  if (config.agent.cliSafeMode) args.push("--safe-mode");

  const chosenEffort = resolveCliEffort({ effort });
  if (CLI_EFFORTS.includes(chosenEffort)) args.push("--effort", chosenEffort);

  const safeChosen = safeArg(model);
  if (safeChosen) args.push("-m", safeChosen);

  return args;
}

function runCommandCode(prompt, timeoutMs, model, cwd, onProgress, signal, maxTurns = 3, apiKey = null, effort = null) {
  const chosen = model || config.agent.model;
  const isAgy = Boolean(chosen && chosen.startsWith("agy:"));
  let executable = config.agent.command;
  let args;

  if (isAgy) {
    executable = "agy";
    args = [
      "--output-format",
      "json",
      "--model",
      safeArg(chosen.slice(4)),
      "--dangerously-skip-permissions",
    ];
  } else {
    args = commandCodeArgs({ maxTurns, model: chosen, effort });
  }

  return (async () => {
    try {
      return await runCliProcess({
        tag: "",
        executable,
        args,
        prompt,
        cwd,
        timeoutMs,
        signal,
        env: cliEnvFor(apiKey),
        onStdoutLine: (event) => {
          const description = describeEvent(event);
          if (description && onProgress) onProgress(description);
        },
      });
    } finally {
      if (isAgy) await pruneAgySessions();
    }
  })();
}

function runCodexCli(prompt, timeoutMs, model, cwd, onProgress, signal) {
  const executable = config.agent.codexBin || "codex";
  let rawModel = model.startsWith("codex:") ? model.slice(6) : model;
  let effort = null;

  if (rawModel.includes(":")) {
    const [name, reasoning] = rawModel.split(":");
    rawModel = safeArg(name);
    effort = safeArg(reasoning); // low, medium, high
  }

  const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  if (rawModel && rawModel !== "default") args.push("-m", rawModel);
  args.push("-");

  return runCliProcess({
    tag: ":codex",
    executable,
    args,
    prompt,
    cwd,
    timeoutMs,
    signal,
    onStdoutLine: (event) => {
      const description = describeEvent(event);
      if (description && onProgress) onProgress(description);
    },
  });
}

function runClaudeCli(prompt, timeoutMs, model, cwd, onProgress, signal) {
  const executable = config.agent.claudeBin || "claude";
  const claudeModel = safeArg(model.startsWith("claude:") ? model.slice(7) : model);
  const args = ["-p", "--output-format", "json"];
  if (claudeModel && claudeModel !== "default") args.push("-m", claudeModel);

  return runCliProcess({
    tag: ":claude",
    executable,
    args,
    prompt,
    cwd,
    timeoutMs,
    signal,
    onProgress,
  });
}

function prepareWorkspace(attachments) {
  if (!attachments || attachments.length === 0) return { dir: null, names: [] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "family-agent-"));
  const names = [];

  for (const file of attachments) {
    const safe = path.basename(file.name || file.path || "document");
    fs.copyFileSync(file.path, path.join(dir, safe));
    names.push(safe);
  }

  return { dir, names };
}

async function codexJson(messages, options = {}) {
  const prompt = flatten(messages);
  const workspace = prepareWorkspace(options.attachments);

  const result = await runCodexCli(
    prompt,
    options.timeoutMs ?? config.agent.timeoutMs,
    options.model || "default",
    workspace.dir,
    options.onProgress,
    options.signal,
  );

  let text = "";
  let usage = null;
  const lines = result.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text && !text) {
        text = parsed.item.text.trim();
      }
      if (parsed.type === "turn.completed" && parsed.usage && !usage) {
        const u = parsed.usage;
        const inputTokens = u.input_tokens || 0;
        const outputTokens = u.output_tokens || 0;
        const totalTokens = u.total_tokens || (inputTokens + outputTokens);
        usage = {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: totalTokens,
          ...u,
        };
      }
      if (text && usage) break;
    } catch {}
  }

  if (!text) {
    text = result.stdout.trim();
  }

  return {
    text,
    json: parseModelJson(text),
    usage,
  };
}

async function claudeCliJson(messages, options = {}) {
  const prompt = flatten(messages);
  const workspace = prepareWorkspace(options.attachments);

  const result = await runClaudeCli(
    prompt,
    options.timeoutMs ?? config.agent.timeoutMs,
    options.model || "default",
    workspace.dir,
    options.onProgress,
    options.signal,
  );

  let text = result.stdout.trim();
  try {
    const frame = JSON.parse(text);
    if (frame && (frame.result || frame.text)) {
      text = frame.result || frame.text;
    }
  } catch {}

  return {
    text,
    json: parseModelJson(text),
    usage: null,
  };
}

async function commandCodeJson(messages, options = {}) {
  const prompt = flatten(messages);
  const workspace = prepareWorkspace(options.attachments);
  const startedAt = Date.now();

  try {
    // The brief needs one answer; a run with no answer yet gets one more turn so the
    // model can finish instead of dying on "Reached maximum conversation turns".
    // Headless runs withhold tools anyway, so nothing is written to disk.
    const extraTurns = Number(options.commandCodeMaxTurns) || 0;
    const maxTurns = (options.attachments && options.attachments.length > 0 ? 3 : 2) + extraTurns;

    const result = await runCommandCode(
      prompt,
      options.timeoutMs ?? config.agent.timeoutMs,
      options.model,
      workspace.dir,
      options.onProgress,
      options.signal,
      maxTurns,
      options.commandCodeApiKey,
      options.effort ?? null,
    );
    const frame = extractResult(result.stdout);
    const usedModel = result.model || extractUsedModel(result.stdout);

    if (frame && frame.subtype === "error") {
      throw attachModel(
        new LlmError(frame.error || result.stderr.trim() || "Command Code returned an error"),
        usedModel,
      );
    }

    let text = "";
    let usage = null;

    if (frame) {
      if (frame.subtype === "error" || frame.status === "ERROR") {
        throw attachModel(
          new LlmError(frame.error || result.stderr.trim() || "Agent returned an error"),
          usedModel,
        );
      }
      text = (frame.finalText || frame.response || "").trim();
      usage = frame.usage ?? null;

      // The CLI stopped before the answer was finished. A turn cap is retried once
      // with one more turn; a token cap means the brief must be split.
      if (!text && isMaxTurnsFrame(frame, result.stderr)) {
        throw attachModel(maxTurnsError(maxTurns), usedModel);
      }
      if (!text && isTruncatedFrame(frame, result.stderr)) {
        const tokens = frame.usage?.outputTokens ?? frame.usage?.output_tokens ?? null;
        throw attachModel(outputLimitError(tokens), usedModel);
      }
    } else {
      try {
        const agyJson = JSON.parse(result.stdout.trim());
        if (agyJson && agyJson.response) {
          text = agyJson.response.trim();
          usage = agyJson.usage ?? null;
        } else if (agyJson && agyJson.finalText) {
          text = agyJson.finalText.trim();
          usage = agyJson.usage ?? null;
        }
      } catch {
        /* not pure JSON string */
      }
    }

    if (!text) {
      text = extractAnswerText(result.stdout);
    }

    if (!text) {
      const summary = (result.stderr.trim() || result.stdout.trim() || "no output from agent").slice(
        -400,
      );
      throw attachModel(new LlmError(`Agent completed without returning a spec: ${summary}`), usedModel);
    }

    const json = parseModelJson(text);
    return {
      text,
      json,
      usage,
      model: usedModel,
      metrics: {
        firstTokenMs: null,
        totalMs: Date.now() - startedAt,
        outChars: text.length,
        via: "cli",
      },
    };
  } finally {
    if (workspace.dir) {
      try { fs.rmSync(workspace.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

let cachedModels = null;
let lastFetchModels = 0;
let modelsInFlight = null;

/**
 * Test hook: a hanging CLI or a missing binary must never stall /api/health.
 * Tests swap the spawner instead of depending on OS scripts.
 */
let spawnOverride = null;
export function __setSpawnOverrideForTests(fn) {
  spawnOverride = fn;
}
export function __resetAgentCachesForTests() {
  cachedModels = null;
  lastFetchModels = 0;
  backendsCache = { at: 0, value: null };
  modelsInFlight = null;
  backendsInFlight = null;
  spawnOverride = null;
}

// `cmdc --list-models` takes ~16 s on a cold Node start here; a 15 s timeout made
// the model list silently empty (the studio dropdown lost every CLI model).
const listTimeoutMs = () => Number(process.env.AGENT_LIST_TIMEOUT || 45000);
const binTimeoutMs = () => Number(process.env.AGENT_BIN_TIMEOUT || 5000);
const modelsTtlMs = () => Number(process.env.AGENT_MODELS_TTL_MS || 60000);
const BACKENDS_TTL_MS = 30000;

function spawnProcess(executable, args, options = {}) {
  return spawnOverride ? spawnOverride(executable, args, options) : spawnCli(executable, args, options);
}

function spawnBinary(command, args, options = {}) {
  return spawnOverride ? spawnOverride(command, args, options) : spawn(command, args, options);
}

function checkBinaryExists(bin) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      child = spawnBinary(cmd, [bin], { stdio: "ignore", windowsHide: true });
    } catch {
      finish(false);
      return;
    }

    timer = setTimeout(() => {
      console.warn(`[agent] checking "${bin}" timed out after ${binTimeoutMs()}ms`);
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, binTimeoutMs());

    child.on("close", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  });
}

/**
 * `cmdc --list-models` prints grouped rows: "<group>" headings followed by
 * "<id>  <description>" lines. Turn that into dropdown entries.
 * A wedged CLI is killed after the timeout and reported as "no models".
 */
export function listCommandModels(command) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawnProcess(command, ["--list-models"], { windowsHide: true });
    } catch {
      finish([]);
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout = keepTail(stdout, chunk.toString(), MAX_LISTING_CHARS);
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (code !== 0 || !stdout) {
        finish([]);
        return;
      }

      const models = [];
      let group = "Models";
      let defaultIndex = -1;
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^available models/i.test(line)) continue;
        if (/^(pass the full id|cmdc? --model|docs:)/i.test(line)) continue;

        const parts = line.split(/\s{2,}/);
        if (parts.length >= 2) {
          const id = parts[0].trim();
          if (!id || /\s/.test(id)) continue;
          if (/\(default\)/i.test(line)) defaultIndex = models.length;
          models.push({
            id,
            category: `Command Code · ${group}`,
            label: id,
          });
        } else {
          group = line;
        }
      }

      // Start the dropdown on the CLI's own default model.
      if (defaultIndex > 0) {
        const [entry] = models.splice(defaultIndex, 1);
        models.unshift(entry);
      }

      finish(models);
    });

    timer = setTimeout(() => {
      console.warn(`[agent] "${command} --list-models" timed out after ${listTimeoutMs()}ms`);
      try { child.kill(); } catch { /* already gone */ }
      finish([]);
    }, listTimeoutMs());
  });
}

function listAgyModels() {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawnProcess("agy", ["models"], { windowsHide: true });
    } catch {
      finish([]);
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout = keepTail(stdout, chunk.toString(), MAX_LISTING_CHARS);
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      const agyList = [];
      if (code === 0 && stdout) {
        for (const rawLine of stdout.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("Fetching") || line.startsWith("Available")) continue;
          const parts = line.split(/\t+/);
          if (parts.length >= 2) {
            agyList.push({
              id: `agy:${parts[0].trim()}`,
              category: "Antigravity CLI (AGY)",
              label: `[AGY] ${parts[1].trim()}`,
            });
          }
        }
      }
      finish(agyList);
    });

    timer = setTimeout(() => {
      console.warn(`[agent] "agy models" timed out after ${listTimeoutMs()}ms`);
      try { child.kill(); } catch { /* already gone */ }
      finish([]);
    }, listTimeoutMs());
  });
}

/**
 * Stale-while-revalidate + in-flight dedupe: concurrent /api/health calls share
 * one listing, and an expired cache is returned immediately while it refreshes.
 */
export async function getCmdcModels() {
  const now = Date.now();
  if (cachedModels && now - lastFetchModels < modelsTtlMs()) return cachedModels;

  if (cachedModels) {
    void refreshModels().catch(() => {});
    return cachedModels;
  }

  return refreshModels();
}

function refreshModels() {
  if (modelsInFlight) return modelsInFlight;

  modelsInFlight = (async () => {
    const list = [];
    const command = config.agent.command || "cmdc";
    const [hasCommand, hasAgy] = await Promise.all([
      checkBinaryExists(command),
      checkBinaryExists("agy"),
    ]);

    // 1. Command Code models, only when the CLI is actually installed here.
    if (hasCommand && command !== "agy") {
      list.push(...(await listCommandModels(command)));
    }

    // 2. Antigravity CLI models
    if (hasAgy) {
      list.push(...(await listAgyModels()));
    }

    // 3. Codex CLI
    const hasCodex = await checkBinaryExists(config.agent.codexBin || "codex");
    if (hasCodex) {
      list.push(
        { id: "codex:default", category: "OpenAI Codex CLI", label: "[Codex] Default Model" },
        { id: "codex:gpt-6-astra:low", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Astra (Low)" },
        { id: "codex:gpt-6-astra:medium", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Astra (Medium)" },
        { id: "codex:gpt-6-astra:high", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Astra (High)" },
        { id: "codex:gpt-6.1-sol:low", category: "OpenAI Codex CLI", label: "[Codex] GPT-6.1 Sol (Low)" },
        { id: "codex:gpt-6.1-sol:medium", category: "OpenAI Codex CLI", label: "[Codex] GPT-6.1 Sol (Medium)" },
        { id: "codex:gpt-6.1-sol:high", category: "OpenAI Codex CLI", label: "[Codex] GPT-6.1 Sol (High)" },
        { id: "codex:gpt-6-sol:low", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Sol (Low)" },
        { id: "codex:gpt-6-sol:medium", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Sol (Medium)" },
        { id: "codex:gpt-6-luna:low", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Luna (Low)" },
        { id: "codex:gpt-6-luna:medium", category: "OpenAI Codex CLI", label: "[Codex] GPT-6 Luna (Medium)" },
        { id: "codex:o4-mini:low", category: "OpenAI Codex CLI", label: "[Codex] o4-mini (Low)" },
        { id: "codex:o4-mini:medium", category: "OpenAI Codex CLI", label: "[Codex] o4-mini (Medium)" },
        { id: "codex:o4-mini:high", category: "OpenAI Codex CLI", label: "[Codex] o4-mini (High)" },
        { id: "codex:gpt-5.6-sol:medium", category: "OpenAI Codex CLI", label: "[Codex] GPT-5.6 Sol (Medium)" },
        { id: "codex:gpt-5.6-terra:medium", category: "OpenAI Codex CLI", label: "[Codex] GPT-5.6 Terra (Medium)" },
      );
    }

    // 4. Claude Code CLI
    const hasClaude = await checkBinaryExists(config.agent.claudeBin || "claude");
    if (hasClaude) {
      list.push(
        { id: "claude:default", category: "Claude Code CLI", label: "[Claude] Default" },
        { id: "claude:claude-3-7-sonnet", category: "Claude Code CLI", label: "[Claude] Claude 3.7 Sonnet" },
      );
    }

    // 5. Custom Direct API option
    list.push({
      id: "custom:api",
      category: "Direct API",
      label: "⚙️ Custom API... (Dán link / cấu hình URL)",
    });

    cachedModels = list;
    lastFetchModels = Date.now();
    return list;
  })()
    .catch((error) => {
      console.warn("[agent] model listing failed:", error?.message);
      return cachedModels ?? [];
    })
    .finally(() => {
      modelsInFlight = null;
    });

  return modelsInFlight;
}

let backendsCache = { at: 0, value: null };
let backendsInFlight = null;

/** Which agent backends this machine can actually run right now. */
export async function detectAgentBackends() {
  if (backendsCache.value && Date.now() - backendsCache.at < BACKENDS_TTL_MS) {
    return backendsCache.value;
  }

  if (backendsCache.value) {
    void refreshBackends().catch(() => {});
    return backendsCache.value;
  }

  return refreshBackends();
}

function refreshBackends() {
  if (backendsInFlight) return backendsInFlight;

  backendsInFlight = (async () => {
    const [commandcode, agy, codex, claude] = await Promise.all([
      checkBinaryExists(config.agent.command || "cmdc"),
      checkBinaryExists("agy"),
      checkBinaryExists(config.agent.codexBin || "codex"),
      checkBinaryExists(config.agent.claudeBin || "claude"),
    ]);

    const value = { commandcode, agy, codex, claude, openai: Boolean(config.llm.apiKey) };
    backendsCache = { at: Date.now(), value };
    return value;
  })()
    .catch(() => ({
      commandcode: false,
      agy: false,
      codex: false,
      claude: false,
      openai: Boolean(config.llm.apiKey),
    }))
    .finally(() => {
      backendsInFlight = null;
    });

  return backendsInFlight;
}

export function agentStatus() {
  const provider = config.agent.provider;
  if (provider === "openai") {
    return {
      provider,
      model: config.agent.model || config.llm.model,
      ready: Boolean(config.llm.apiKey),
      detail: config.llm.apiKey ? "OpenAI compatible endpoint" : "OPENAI_API_KEY is not set",
    };
  }

  const isAgy = config.agent.model.startsWith("agy:") || config.agent.command === "agy";
  return {
    provider,
    model: config.agent.model || (isAgy ? "Antigravity CLI (agy)" : "command code default"),
    ready: true,
    detail: isAgy ? `runs Antigravity CLI (agy) on this machine` : `runs "${config.agent.command} -p" on this machine`,
  };
}

/**
 * Fallback chain for a failed primary model. Only models this machine can actually
 * run are offered: an installed CLI, or the direct API with a valid key.
 */
export async function resolveFallbackModels(primary, { backends, provider } = {}) {
  if (config.agent.fallbackModels.length > 0) {
    return config.agent.fallbackModels.filter((model) => model && model !== primary);
  }

  const detected = backends ?? (await detectAgentBackends());
  const chosen = (primary || config.agent.model || "").trim();

  if (chosen === "custom:api") return [];
  if (chosen.startsWith("codex:")) return detected.codex ? ["codex:default"] : [];
  if (chosen.startsWith("claude:")) return detected.claude ? ["claude:default"] : [];
  if ((provider ?? config.agent.provider) === "openai") return [];

  const models = detected.commandcode ? await getCmdcModels() : [];
  const ids = models
    .map((entry) => entry.id)
    .filter(
      (id) =>
        id &&
        id !== chosen &&
        !id.startsWith("codex:") &&
        !id.startsWith("claude:") &&
        id !== "custom:api",
    );

  // The CLI silently runs its own default when it does not know the id, so say so
  // instead of pretending the requested model is what answered.
  if (chosen && models.length > 0 && !models.some((entry) => entry.id === chosen)) {
    console.warn(
      `[design] model "${chosen}" không có trong danh sách của ${config.agent.command}; ` +
        "CLI có thể chạy model mặc định của nó",
    );
  }

  const fast = ids.filter((id) => /flash|lite|mini|fast|haiku/i.test(id));
  const rest = ids.filter((id) => !fast.includes(id));

  return [...new Set([...fast.slice(0, 2), ...rest.slice(0, 1)])];
}

function hasImageParts(messages) {
  return (messages ?? []).some(
    (message) =>
      Array.isArray(message?.content) &&
      message.content.some((part) => part && part.type === "image"),
  );
}

function callBackend(messages, options) {
  const chosen = (options.model || config.agent.model || "").trim();
  const images = hasImageParts(messages);

  // 1. Direct API via Custom API or config
  if (chosen === "custom:api" || options.customApiConfig) {
    return dispatchCustomApi(messages, {
      ...options,
      ...(options.customApiConfig || {}),
    });
  }

  if (config.agent.provider === "openai") {
    return openAiChatJson(messages, options);
  }

  // A CLI has no image input in this app: say so instead of flattening objects.
  if (images) {
    throw new LlmError(
      `Backend CLI không nhận ảnh (model "${chosen || "mặc định"}"). ` +
        "Chọn model vision hoặc cấu hình Direct API trong ô model.",
    );
  }

  // 2. Codex CLI
  if (chosen.startsWith("codex:")) {
    return codexJson(messages, options);
  }

  // 3. Claude Code CLI
  if (chosen.startsWith("claude:")) {
    return claudeCliJson(messages, options);
  }

  // 4. Default / AGY / Command Code
  return commandCodeJson(messages, options);
}

/** Models to try for one call: the selected one, then fallbacks unless the user locked it. */
export function modelCandidates(primary, fallbacks = [], { lockModel = false, customApiConfig } = {}) {
  const base = [primary || "default"];
  if (lockModel || customApiConfig) return base;

  return [...new Set([...base, ...(fallbacks ?? [])].filter(Boolean))];
}

/**
 * Picking a model in the dropdown is the user's decision: it is used as-is and a
 * provider hiccup never silently moves the run to another model. Only the server
 * default (no explicit choice) may fall back, or an explicit `lockModel: false`.
 */
export function isModelLocked({ model, lockModel } = {}) {
  if (typeof lockModel === "boolean") return lockModel;
  return Boolean(model && String(model).trim());
}

export async function generateJson(messages, options = {}) {
  const primary = (options.model || config.agent.model || "").trim();
  const locked = isModelLocked({ model: options.model, lockModel: options.lockModel });

  // A custom endpoint belongs to one provider; switching models there is the user's job.
  const fallbacks =
    locked || options.customApiConfig
      ? []
      : await resolveFallbackModels(primary, {
          backends: options.backends,
          provider: options.provider,
        });

  return runWithModelFallback({
    models: modelCandidates(primary, fallbacks, {
      lockModel: locked,
      customApiConfig: options.customApiConfig,
    }),
    run: (model) => callBackend(messages, { ...options, model }),
    retryMax: options.retryMax ?? config.agent.retryMax,
    baseMs: options.retryBaseMs ?? config.agent.retryBaseMs,
    jitter: options.jitter,
    signal: options.signal,
    sleep: options.sleep,
    onRetry: options.onRetry,
    onFallback: options.onFallback,
  });
}
