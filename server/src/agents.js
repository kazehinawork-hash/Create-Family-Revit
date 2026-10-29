import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { LlmError, chatJson as openAiChatJson, dispatchCustomApi, parseModelJson } from "./llm.js";

function flatten(messages) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const turns = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role === "assistant" ? "ASSISTANT" : "USER"}:\n${message.content}`)
    .join("\n\n---\n\n");

  return `${system}\n\n---\n\n${turns}\n\nCRITICAL OUTPUT REQUIREMENT:\n- Return ONLY a single raw JSON object representing the complete spec.\n- Do NOT write conversational explanations, markdown notes, or preface text before or after the JSON.\n- Ensure all quotes and brackets inside string expressions (e.g. \"[Casing Length] / 2\") are properly closed and valid JSON.`;
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
}

function runCommandCode(prompt, timeoutMs, model, cwd, onProgress, signal) {
  return new Promise((resolve, reject) => {
    let executable = config.agent.command;
    let args = [];
    const chosen = model || config.agent.model;

    if (chosen && chosen.startsWith("agy:")) {
      executable = "agy";
      const agyModel = chosen.slice(4);
      args = ["--output-format", "json", "--model", agyModel, "--dangerously-skip-permissions"];
    } else {
      args = ["-p", "--output-format", "json", "--skip-onboarding", "--max-turns", "3"];
      if (chosen) args.push("-m", chosen);
    }

    const started = Date.now();
    console.log(
      `[agent] spawn ${executable} model=${chosen || "default"} cwd=${cwd || os.tmpdir()} prompt=${prompt.length}B`,
    );

    let child;
    try {
      child = spawn(executable, args, {
        cwd: cwd || os.tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      return reject(new LlmError(`Failed to spawn CLI (${executable}): ${err.message}`));
    }

    let stdout = "";
    let stderr = "";
    let buffer = "";

    const timer = setTimeout(() => {
      console.warn(`[agent] timeout after ${timeoutMs}ms, killing ${executable}`);
      killTree(child);
      reject(new LlmError(`Agent run timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const onAbort = () => {
      console.log(`[agent] aborted by user, killing ${executable}`);
      killTree(child);
      reject(new LlmError("Agent run was cancelled"));
    };

    if (signal) {
      if (signal.aborted) {
        killTree(child);
        return reject(new LlmError("Agent run was cancelled"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (callback) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      callback();
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const event = JSON.parse(trimmed);
          const description = describeEvent(event);
          if (description && onProgress) {
            onProgress(description);
          }
        } catch {
          /* partial or non JSON line */
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      console.error(`[agent] spawn error: ${error.message}`);
      finish(() => reject(new LlmError(`Could not run "${executable}": ${error.message}`)));
    });

    child.on("close", (code) => {
      console.log(
        `[agent] exit ${code} in ${Math.round((Date.now() - started) / 1000)}s stdout=${stdout.length}B stderr=${stderr.length}B`,
      );
      if (stderr.trim()) console.log(`[agent] stderr: ${stderr.trim().slice(-600)}`);
      finish(() => resolve({ code: code ?? 0, stdout, stderr }));
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      finish(() => reject(new LlmError(`Could not send prompt to ${executable}: ${error.message}`)));
    }
  });
}

function runCodexCli(prompt, timeoutMs, model, cwd, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const executable = config.agent.codexBin || "codex";
    let rawModel = model.startsWith("codex:") ? model.slice(6) : model;
    let effort = null;
    if (rawModel.includes(":")) {
      const parts = rawModel.split(":");
      rawModel = parts[0];
      effort = parts[1]; // low, medium, high
    }

    const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
    if (effort) {
      args.push("-c", `model_reasoning_effort="${effort}"`);
    }
    if (rawModel && rawModel !== "default") {
      args.push("-m", rawModel);
    }
    args.push("-");

    const started = Date.now();
    console.log(`[agent:codex] spawn ${executable} model=${rawModel || "default"}${effort ? ` (${effort})` : ""} cwd=${cwd || os.tmpdir()}`);

    let child;
    try {
      child = spawn(executable, args, {
        cwd: cwd || undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return reject(new LlmError(`Failed to spawn Codex CLI (${executable}): ${err.message}`));
    }

    let stdout = "";
    let stderr = "";
    let buffer = "";

    const timer = setTimeout(() => {
      console.warn(`[agent:codex] timeout after ${timeoutMs}ms, killing codex`);
      killTree(child);
      reject(new LlmError(`Codex CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const onAbort = () => {
      console.log(`[agent:codex] aborted by user, killing codex`);
      killTree(child);
      reject(new LlmError("Codex CLI run was cancelled"));
    };

    if (signal) {
      if (signal.aborted) {
        killTree(child);
        return reject(new LlmError("Codex CLI run was cancelled"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (callback) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      callback();
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const event = JSON.parse(trimmed);
          const desc = describeEvent(event);
          if (desc && onProgress) onProgress(desc);
        } catch {
          /* not json */
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      console.error(`[agent:codex] spawn error: ${error.message}`);
      finish(() => reject(new LlmError(`Could not run Codex CLI: ${error.message}`)));
    });

    child.on("close", (code) => {
      console.log(`[agent:codex] exit ${code} in ${Math.round((Date.now() - started) / 1000)}s`);
      if (stderr.trim()) console.log(`[agent:codex] stderr: ${stderr.trim().slice(-600)}`);
      finish(() => resolve({ code: code ?? 0, stdout, stderr }));
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      finish(() => reject(new LlmError(`Could not send prompt to Codex: ${error.message}`)));
    }
  });
}

function runClaudeCli(prompt, timeoutMs, model, cwd, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const executable = config.agent.claudeBin || "claude";
    const claudeModel = model.startsWith("claude:") ? model.slice(7) : model;
    const args = ["-p", "--output-format", "json"];
    if (claudeModel && claudeModel !== "default") {
      args.push("-m", claudeModel);
    }

    const started = Date.now();
    console.log(`[agent:claude] spawn ${executable} model=${claudeModel || "default"} cwd=${cwd || os.tmpdir()}`);

    let child;
    try {
      child = spawn(executable, args, {
        cwd: cwd || undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return reject(new LlmError(`Failed to spawn Claude CLI (${executable}): ${err.message}`));
    }

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      killTree(child);
      reject(new LlmError(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      reject(new LlmError("Claude CLI run was cancelled"));
    };

    if (signal) {
      if (signal.aborted) {
        killTree(child);
        return reject(new LlmError("Claude CLI run was cancelled"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (callback) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      callback();
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (onProgress) onProgress("Writing the spec");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      finish(() => reject(new LlmError(`Could not run Claude CLI: ${error.message}`)));
    });

    child.on("close", (code) => {
      finish(() => resolve({ code: code ?? 0, stdout, stderr }));
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      finish(() => reject(new LlmError(`Could not send prompt to Claude: ${error.message}`)));
    }
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

  try {
    const result = await runCommandCode(
      prompt,
      options.timeoutMs ?? config.agent.timeoutMs,
      options.model,
      workspace.dir,
      options.onProgress,
      options.signal,
    );
    const frame = extractResult(result.stdout);

    if (frame && frame.subtype === "error") {
      throw new LlmError(frame.error || result.stderr.trim() || "Command Code returned an error");
    }

    let text = "";
    let usage = null;

    if (frame) {
      if (frame.subtype === "error" || frame.status === "ERROR") {
        throw new LlmError(frame.error || result.stderr.trim() || "Agent returned an error");
      }
      text = (frame.finalText || frame.response || "").trim();
      usage = frame.usage ?? null;
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
      const match = result.stdout.match(/\{[\s\S]*\}/);
      if (match) {
        text = match[0];
      }
    }

    if (!text) {
      const summary = (result.stderr.trim() || result.stdout.trim() || "no output from agent").slice(
        -400,
      );
      throw new LlmError(`Agent completed without returning a spec: ${summary}`);
    }

    const json = parseModelJson(text);
    return { text, json, usage };
  } finally {
    if (workspace.dir) {
      try { fs.rmSync(workspace.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

let cachedModels = null;
let lastFetchModels = 0;

function checkBinaryExists(bin) {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const child = spawn(cmd, [bin], { stdio: "ignore", windowsHide: true });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function getCmdcModels() {
  const now = Date.now();
  if (false) {
    return cachedModels;
  }

  const list = [];

  // 1. Fetch agy models
  const agyModels = await new Promise((resolve) => {
    const child = spawn("agy", ["models"], { shell: true, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
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
      resolve(agyList);
    });
    child.on("error", () => resolve([]));
  });
  list.push(...agyModels);

  // 2. Check Codex CLI
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

  // 3. Check Claude CLI
  const hasClaude = await checkBinaryExists(config.agent.claudeBin || "claude");
  if (hasClaude) {
    list.push(
      { id: "claude:default", category: "Claude Code CLI", label: "[Claude] Default" },
      { id: "claude:claude-3-7-sonnet", category: "Claude Code CLI", label: "[Claude] Claude 3.7 Sonnet" },
    );
  }

  // 4. Custom Direct API option
  list.push({
    id: "custom:api",
    category: "Direct API",
    label: "⚙️ Custom API... (Dán link / cấu hình URL)",
  });

  cachedModels = list;
  lastFetchModels = now;
  return list;
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

export async function generateJson(messages, options = {}) {
  const chosen = (options.model || config.agent.model || "").trim();

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
