import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { LlmError, chatJson as openAiChatJson, parseModelJson } from "./llm.js";

/**
 * The design step is pluggable: either a local Command Code CLI run (headless) or any
 * OpenAI compatible chat completions endpoint.
 */

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
  // agy stream event types
  if (event.event === "step_update" || event.step_type) {
    const st = event.step_type || event.step_update?.step_type;
    if (st === "thinking") return "Thinking";
    if (st === "call_tool" || st === "tool_call") return "Consulting tools";
    if (st === "planner_response" || st === "message") return "Writing the spec";
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
      // agy reads directly from stdin when no -p flag is provided; DO NOT use shell: true on Windows
      args = ["--output-format", "json", "--model", agyModel, "--dangerously-skip-permissions"];
    } else {
      args = ["-p", "--output-format", "json", "--skip-onboarding", "--max-turns", "3"];
      if (chosen) args.push("-m", chosen);
    }

    const started = Date.now();
    console.log(
      `[agent] spawn ${executable} model=${chosen || "default"} cwd=${cwd || os.tmpdir()} prompt=${prompt.length}B`,
    );

    const isAgy = chosen && chosen.startsWith("agy:");
    const child = spawn(executable, args, {
      cwd: cwd || os.tmpdir(),
      shell: !isAgy, // Avoid shell wrapping for agy so raw stdin pipe works cleanly
      windowsHide: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let pending = "";
    let lastMessage = "";
    let lastAt = 0;

    const progress = (text) => {
      if (!onProgress || !text) return;
      const now = Date.now();
      if (text === lastMessage || now - lastAt < 800) return;
      lastMessage = text;
      lastAt = now;
      onProgress(text);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      console.error(`[agent] timeout after ${Math.round((Date.now() - started) / 1000)}s, stderr: ${stderr.slice(-500)}`);
      reject(new LlmError(`Command Code did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    if (signal) {
      const cancel = () => {
        console.log("[agent] cancelled by the studio");
        finish(() => {
          killTree(child);
          reject(new LlmError("Cancelled"));
        });
      };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pending += text;

      let index = pending.indexOf("\n");
      while (index >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");

        if (!line.startsWith("{")) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.type === "event") {
            progress(describeEvent(frame.event ?? {}));
          } else if (frame.event) {
            progress(describeEvent(frame));
          }
        } catch {
          /* partial or non JSON line */
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (error) => {
      console.error(`[agent] spawn error: ${error.message}`);
      finish(() => reject(new LlmError(`Could not run "${config.agent.command}": ${error.message}`)));
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
      finish(() => reject(new LlmError(`Could not send the prompt to Command Code: ${error.message}`)));
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
      // Check if raw output has JSON from agy
      try {
        const agyJson = JSON.parse(result.stdout.trim());
        if (agyJson && agyJson.response) {
          text = agyJson.response.trim();
          usage = agyJson.usage ?? null;
        }
      } catch {
        /* not pure JSON */
      }
    }

    if (!text) text = result.stdout.trim();

    if (!text) {
      throw new LlmError(
        result.stderr.trim() ||
          `Agent produced no answer (exit code ${result.code}).`,
      );
    }

    return {
      text,
      json: parseModelJson(text),
      usage,
    };
  } finally {
    if (workspace.dir) {
      try { fs.rmSync(workspace.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

let cachedModels = null;
let lastFetchModels = 0;

export async function getCmdcModels() {
  const now = Date.now();
  if (cachedModels && now - lastFetchModels < 120000) {
    return cachedModels;
  }

  // 1. Fetch agy models if agy is available
  const agyModels = await new Promise((resolve) => {
    const child = spawn("agy", ["models"], { shell: true, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0 || !stdout) {
        resolve([]);
        return;
      }
      const list = [];
      const lines = stdout.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("Fetching") || line.startsWith("Available")) continue;
        const parts = line.split(/\t+/);
        if (parts.length >= 2) {
          const id = parts[0].trim();
          const desc = parts[1].trim();
          list.push({
            id: `agy:${id}`,
            category: "Antigravity (AGY)",
            label: `[AGY] ${desc}`,
          });
        }
      }
      resolve(list);
    });
    child.on("error", () => resolve([]));
  });

  return new Promise((resolve) => {
    const child = spawn(config.agent.command, ["--list-models"], {
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("close", (code) => {
      const list = [...agyModels];
      if (code !== 0 || !stdout) {
        cachedModels = list.length > 0 ? list : (cachedModels || []);
        resolve(cachedModels || []);
        return;
      }

      const lines = stdout.split(/\r?\n/);
      let currentCategory = "General";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("Available models") || line.startsWith("Pass the full") || line.startsWith("cmdc --model") || line.startsWith("Docs:") || line.startsWith("Decision models")) {
          continue;
        }

        // Category headers like "Open Source", "Anthropic", "OpenAI", "Google", "xAI"
        if (!line.includes("  ") && !line.includes("/") && line.length < 30) {
          currentCategory = line;
          continue;
        }

        // Model line format: "<model-id>   <description>"
        const match = line.match(/^([a-zA-Z0-9_\-\.\/:]+)\s+(.+)$/);
        if (match) {
          const id = match[1];
          const desc = match[2].trim();
          list.push({
            id,
            category: `cmdc: ${currentCategory}`,
            label: `${id.split("/").pop()} (${desc.slice(0, 32)})`,
          });
        }
      }

      cachedModels = list;
      lastFetchModels = now;
      resolve(list);
    });
    child.on("error", () => resolve(agyModels.length > 0 ? agyModels : (cachedModels || [])));
  });
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
  if (config.agent.provider === "openai") {
    if (options.attachments && options.attachments.length > 0) {
      throw new LlmError(
        "Attachments are read by the Command Code CLI. Set AGENT_PROVIDER=commandcode to use them.",
      );
    }
    return openAiChatJson(messages, options);
  }
  return commandCodeJson(messages, options);
}
