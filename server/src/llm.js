
/**
 * Chuẩn hóa tên model do người dùng nhập tự do sang ID chuẩn của API.
 */
export function normalizeModelId(rawModel, provider = "openai") {
  if (!rawModel || typeof rawModel !== "string" || !rawModel.trim()) {
    if (provider === "gemini") return "gemini-2.5-flash";
    if (provider === "anthropic") return "claude-3-7-sonnet-latest";
    return "gpt-4o";
  }

  const clean = rawModel.trim();
  const lower = clean.toLowerCase();

  // 1. Google Gemini mappings
  if (provider === "gemini" || lower.includes("gemini")) {
    if (lower.includes("3.8") && lower.includes("flash") && lower.includes("lite")) return "gemini-3.8-flash-lite";
    if (lower.includes("3.8") && lower.includes("flash")) return "gemini-3.8-flash";
    if (lower.includes("2.5") && lower.includes("pro")) return "gemini-2.5-pro";
    if (lower.includes("2.5") && lower.includes("flash")) return "gemini-2.5-flash";
    if (lower.includes("2.0") && lower.includes("flash")) return "gemini-2.0-flash";
    if (lower.includes("1.5") && lower.includes("pro")) return "gemini-1.5-pro";
    if (lower.includes("1.5") && lower.includes("flash")) return "gemini-1.5-flash";
    // Tự động chuyển dạng "Gemini 2.5 Flash" -> "gemini-2.5-flash"
    return lower.replace(/\s+/g, "-");
  }

  // 2. Anthropic mappings
  if (provider === "anthropic" || lower.includes("claude")) {
    if (lower.includes("3.7") && lower.includes("sonnet")) return "claude-3-7-sonnet-latest";
    if (lower.includes("3.5") && lower.includes("sonnet")) return "claude-3-5-sonnet-latest";
    if (lower.includes("3.5") && lower.includes("haiku")) return "claude-3-5-haiku-latest";
    if (lower.includes("opus")) return "claude-3-opus-latest";
    return lower.replace(/\s+/g, "-");
  }

  // 3. OpenAI mappings
  if (lower.includes("gpt 4o") || lower === "gpt4o" || lower === "gpt 4") return "gpt-4o";
  if (lower.includes("gpt 4o mini") || lower === "gpt4o mini") return "gpt-4o-mini";
  if (lower.includes("o3 mini") || lower === "o3-mini") return "o3-mini";
  if (lower.includes("o3") && !lower.includes("mini")) return "o3";

  // Thay khoảng trắng thành dấu gạch nối nếu nhập tên tự do
  return clean.includes(" ") ? lower.replace(/\s+/g, "-") : clean;
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import { config, ROOT } from "./config.js";

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

/** Base64 payload for an image part ({path}|{buffer}|data URL). */
function imageBase64(part) {
  try {
    if (part?.buffer) {
      return Buffer.from(part.buffer).toString("base64");
    }
    if (part?.path) {
      return readFileSync(part.path).toString("base64");
    }
    if (typeof part?.url === "string" && part.url.startsWith("data:")) {
      return part.url.slice(part.url.indexOf(",") + 1);
    }
  } catch {
    return null;
  }
  return null;
}

/** Split a message content (string or multimodal array) per provider. */
function contentParts(content) {
  if (typeof content === "string") return { text: content, images: [] };

  const texts = [];
  const images = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    if (part.type === "image") {
      const data = imageBase64(part);
      if (data) images.push({ mime: part.mime || "image/png", data });
    }
  }
  return { text: texts.join("\n\n"), images };
}

function openAiContent(content) {
  if (typeof content === "string") return content;
  const parts = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "text") parts.push({ type: "text", text: part.text });
    if (part?.type === "image") {
      const data = imageBase64(part);
      if (data) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mime || "image/png"};base64,${data}` },
        });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

function stripFences(text) {
  let trimmed = text.trim();
  if (trimmed.includes("```")) {
    const match = trimmed.match(/```(?:json|python)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      trimmed = match[1].trim();
    }
  }
  return trimmed;
}

/**
 * Executes one fetch. Retries (429/5xx/network, with backoff and Retry-After)
 * live in retry.js so every backend shares a single policy.
 */
async function fetchWithRetry(url, init, retries = 0, baseDelayMs = 1200) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, init);
      // If rate limited or server overloaded and retries remain, wait and retry
      if (
        attempt < retries &&
        (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504)
      ) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`[llm] HTTP ${response.status} from ${url.split("?")[0]}, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries && (err.name === "TypeError" || err.message?.includes("fetch failed"))) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`[llm] Network failure, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/** Honour `Retry-After` (seconds or HTTP date) when a provider sends one. */
function retryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function providerError(prefix, response, detail, model) {
  const error = new LlmError(
    `${prefix} (${response.status})${model ? ` [${model}]` : ""}: ${String(detail).slice(0, 500)}`,
    response.status,
  );
  error.model = model;
  const wait = retryAfterMs(response);
  if (wait !== undefined) error.retryAfterMs = wait;
  return error;
}

function noJsonError(text) {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
  const error = new LlmError(
    `The model replied with text instead of a JSON spec: "${preview}${preview.length >= 120 ? "…" : ""}"`,
  );
  error.text = text;
  return error;
}

/** True when every brace/bracket is closed and no string is left open. */
function isBalancedJson(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of String(text ?? "")) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }

  return depth === 0 && !inString;
}

/** The answer stops mid-way (token cap) instead of closing the JSON object. */
export function looksTruncated(text) {
  const clean = stripFences(text);
  const firstBrace = clean.indexOf("{");
  if (firstBrace < 0) return false;

  const body = clean.slice(firstBrace);
  const lastBrace = body.lastIndexOf("}");
  const slice = lastBrace > 0 ? body.slice(0, lastBrace + 1) : body;

  return !isBalancedJson(slice);
}

export function parseModelJson(text) {
  const clean = stripFences(text);

  const firstBrace = clean.indexOf("{");
  if (firstBrace < 0) throw noJsonError(text);

  const body = clean.slice(firstBrace);
  const lastBrace = body.lastIndexOf("}");
  const slice = lastBrace > 0 ? body.slice(0, lastBrace + 1) : body;

  // The model ran out of output tokens: no amount of repair turns a half-written
  // family into a buildable one. Report it as OUTPUT_LIMIT so the design pipeline
  // rebuilds the brief section by section instead of failing the whole request.
  if (!isBalancedJson(slice)) {
    const error = new LlmError(
      "Model output ended before the JSON was closed (OUTPUT_LIMIT) — retry with a shorter brief",
    );
    error.code = "OUTPUT_LIMIT";
    error.raw = text;
    throw error;
  }

  // 1. Direct parse of the object, prose around it removed.
  try {
    return JSON.parse(slice);
  } catch {
    /* keep repairing */
  }

  // 2. jsonrepair handles trailing commas, raw newlines and stray quotes.
  try {
    return JSON.parse(jsonrepair(slice));
  } catch {
    /* keep repairing */
  }

  // 3. Common LLM corruptions inside values, then close what is still open.
  let sanitized = slice
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/:\s*"([^"]*)"([^",}\]]+)"/g, ':"$1 $2"');

  try {
    return JSON.parse(jsonrepair(sanitized));
  } catch {
    /* keep repairing */
  }

  const openBraces = (sanitized.match(/\{/g) || []).length;
  const closeBraces = (sanitized.match(/\}/g) || []).length;
  const openBrackets = (sanitized.match(/\[/g) || []).length;
  const closeBrackets = (sanitized.match(/\]/g) || []).length;

  if (openBrackets > closeBrackets) sanitized += "]".repeat(openBrackets - closeBrackets);
  if (openBraces > closeBraces) sanitized += "}".repeat(openBraces - closeBraces);

  try {
    return JSON.parse(jsonrepair(sanitized));
  } catch (err3) {
    const error = new LlmError(`Model returned unparseable JSON: ${err3.message}`);
    error.raw = text;
    error.sanitized = sanitized;
    throw error;
  }
}

let cachedSpecSchema;
let schemaSupported = true;

export function specResponseSchema() {
  if (cachedSpecSchema !== undefined) return cachedSpecSchema;

  try {
    cachedSpecSchema = JSON.parse(
      readFileSync(path.join(ROOT, "spec", "family-spec.schema.json"), "utf8"),
    );
  } catch {
    cachedSpecSchema = null;
  }

  return cachedSpecSchema;
}

function responseFormat() {
  const schema = specResponseSchema();
  if (schemaSupported && schema) {
    return { type: "json_schema", json_schema: { name: "family_spec", strict: true, schema } };
  }

  return { type: "json_object" };
}

/**
 * Identify API provider by endpoint URL.
 */
export function detectApiProvider(url) {
  if (!url) return "openai";
  const lower = url.toLowerCase();
  if (lower.includes("googleapis.com")) return "gemini";
  if (lower.includes("anthropic.com")) return "anthropic";
  return "openai";
}

/**
 * Direct call to Google Gemini API (generateContent)
 */
export async function geminiChatJson(messages, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new LlmError("API Key is missing for Google Gemini API.");
  }

  let baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  baseUrl = baseUrl.replace(/\/+$/, "");

  const model = normalizeModelId(options.model, "gemini");
  const systemMessage = messages.find((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  const contents = conversation.map((m) => {
    const parts = [];
    for (const part of Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }]) {
      if (part?.type === "text") parts.push({ text: part.text });
      if (part?.type === "image") {
        const data = imageBase64(part);
        if (data) parts.push({ inlineData: { mimeType: part.mime || "image/png", data } });
      }
    }
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: parts.length > 0 ? parts : [{ text: "" }],
    };
  });

  const body = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      responseMimeType: "application/json",
    },
  };

  if (systemMessage) {
    body.systemInstruction = {
      parts: [{ text: systemMessage.content }],
    };
  }

  let endpoint = baseUrl;
  if (!endpoint.includes("/models/")) {
    endpoint = `${endpoint}/models/${model}:generateContent`;
  }
  if (!endpoint.includes("key=")) {
    endpoint += (endpoint.includes("?") ? "&" : "?") + `key=${apiKey}`;
  }

  const res = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw providerError("Gemini API error", res, errText, model);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new LlmError("Gemini API returned an empty response");
  }

  let usage = null;
  if (data.usageMetadata) {
    const prompt = data.usageMetadata.promptTokenCount || 0;
    const candidates = data.usageMetadata.candidatesTokenCount || 0;
    usage = {
      prompt_tokens: prompt,
      completion_tokens: candidates,
      total_tokens: data.usageMetadata.totalTokenCount || (prompt + candidates),
      ...data.usageMetadata,
    };
  }

  return {
    text,
    json: parseModelJson(text),
    usage,
  };
}

/**
 * Direct call to Anthropic Messages API
 */
export async function anthropicChatJson(messages, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new LlmError("API Key is missing for Anthropic Claude API.");
  }

  let baseUrl = options.baseUrl || "https://api.anthropic.com/v1";
  baseUrl = baseUrl.replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/messages") ? baseUrl : `${baseUrl}/messages`;

  const model = normalizeModelId(options.model, "anthropic");
  const systemMessage = messages.find((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  const formattedMessages = conversation.map((m) => {
    const { text, images } = contentParts(m.content);
    if (images.length === 0) {
      return { role: m.role === "assistant" ? "assistant" : "user", content: text };
    }
    return {
      role: m.role === "assistant" ? "assistant" : "user",
      content: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mime, data: image.data },
        })),
      ],
    };
  });

  const body = {
    model,
    messages: formattedMessages,
    max_tokens: options.maxTokens ?? 8192,
    temperature: options.temperature ?? 0.2,
  };

  if (systemMessage) {
    body.system = systemMessage.content + "\n\nCRITICAL: Respond ONLY in valid JSON.";
  }

  const res = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw providerError("Anthropic API error", res, errText, model);
  }

  const data = await res.json();
  const text = data?.content?.[0]?.text;
  if (!text) {
    throw new LlmError("Anthropic API returned an empty response");
  }

  let usage = null;
  if (data.usage) {
    const input = data.usage.input_tokens || 0;
    const output = data.usage.output_tokens || 0;
    usage = {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: (data.usage.total_tokens || 0) || (input + output),
      ...data.usage,
    };
  }

  return {
    text,
    json: parseModelJson(text),
    usage,
  };
}

/**
 * Call OpenAI Compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, etc.)
 */
/**
 * Reads an SSE completion stream. The call is bounded by "no new token" time instead
 * of total wall-clock time, so a model that is actually writing is never cut off,
 * while a silent socket still fails within `idleMs`. `maxTotalMs` stays as a ceiling.
 */
async function readCompletionStream(response, options = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;

  const decoder = new TextDecoder();
  const idleMs = Math.max(50, Number(options.idleMs) || 90000);
  const maxTotalMs = Math.max(idleMs, Number(options.maxTotalMs) || 180000);
  const onProgress = options.onProgress;
  const startedAt = options.startedAt ?? Date.now();

  let buffer = "";
  let text = "";
  let usage = null;
  let firstTokenMs = null;

  const progressMs = Math.max(10, Number(options.progressMs) || 2000);
  const progress = setInterval(() => {
    if (text && onProgress) onProgress(`Đang viết… ${Math.max(1, Math.round(text.length / 4))} token`);
  }, progressMs);
  progress.unref?.();

  /** Read one chunk, or report a timeout after `ms` without data. */
  const readWithTimeout = async (ms) => {
    let timer;
    const timeout = new Promise((resolve) => {
      // Deliberately ref'd: while the timer is the only pending work, an unref'd
      // timer lets the event loop drain and the request would look cancelled.
      timer = setTimeout(() => resolve({ timeout: true }), Math.max(50, ms));
    });
    const read = reader.read();
    try {
      return { ...(await Promise.race([read, timeout])), read };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= maxTotalMs) {
        throw new LlmError(
          `Lượt gọi model vượt trần ${Math.round(maxTotalMs / 1000)}s — dừng lượt này.`,
        );
      }

      const chunk = await readWithTimeout(Math.min(idleMs, maxTotalMs - elapsed));

      if (chunk?.timeout) {
        // Nothing new arrived: cancel the socket, then wait for the pending read to
        // settle so the test runner (and the event loop) does not see a dangling promise.
        Promise.resolve(reader.cancel?.()).catch(() => {});
        try {
          await chunk.read;
        } catch {
          /* the read is aborted together with the stream */
        }
        throw new LlmError(
          Date.now() - startedAt >= maxTotalMs
            ? `Lượt gọi model vượt trần ${Math.round(maxTotalMs / 1000)}s — dừng lượt này.`
            : `Model không gửi thêm token nào trong ${Math.round(idleMs / 1000)}s — dừng lượt này.`,
        );
      }

      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event?.error) {
          throw new LlmError(
            `Model trả lỗi giữa dòng: ${String(event.error.message ?? event.error).slice(0, 300)}`,
          );
        }
        if (event?.usage) usage = event.usage;

        const delta =
          event?.choices?.[0]?.delta?.content ??
          event?.choices?.[0]?.message?.content ??
          "";
        if (typeof delta === "string" && delta) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          text += delta;
        }
      }
    }
  } finally {
    clearInterval(progress);
    try {
      reader.releaseLock?.();
    } catch {
      /* stream closed */
    }
  }

  if (!text.trim()) return null;
  return {
    text,
    usage,
    metrics: { firstTokenMs, totalMs: Date.now() - startedAt, outChars: text.length },
  };
}

export async function chatJson(messages, options = {}) {
  const apiKey = options.apiKey || config.llm.apiKey;
  const baseUrl = (options.baseUrl || config.llm.baseUrl).replace(/\/+$/, "");
  const model = normalizeModelId(options.model, "openai");
  const startedAt = Date.now();

  if (!apiKey && !baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
    throw new LlmError(
      "API Key is missing for OpenAI-compatible endpoint. Please provide an API Key.",
    );
  }

  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: messages.map((message) => ({
      ...message,
      content: openAiContent(message.content),
    })),
    temperature: options.temperature ?? config.llm.temperature,
    max_tokens: options.maxTokens ?? config.llm.maxTokens,
    response_format: responseFormat(),
    // Streaming lets the studio show "Đang viết… N token" and makes an idle socket
    // detectable long before the whole-turn ceiling.
    stream: options.stream !== false,
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const request = () =>
    fetchWithRetry(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
    });

  let response;
  try {
    response = await request();
  } catch (error) {
    throw new LlmError(`Could not reach the model endpoint: ${error.message}`);
  }

  if (
    !response.ok &&
    body.response_format.type === "json_schema" &&
    (response.status === 400 || response.status === 404 || response.status === 422)
  ) {
    schemaSupported = false;
    body.response_format = { type: "json_object" };
    try {
      response = await request();
    } catch (error) {
      throw new LlmError(`Could not reach the model endpoint: ${error.message}`);
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw providerError(
      "Model request failed",
      response,
      detail || response.statusText,
      model,
    );
  }

  const contentType = String(response.headers?.get?.("content-type") || "");
  const streamed =
    body.stream && (contentType.includes("event-stream") || contentType.includes("stream"))
      ? await readCompletionStream(response, {
          idleMs: options.idleMs ?? config.llm.streamIdleMs,
          maxTotalMs: options.timeoutMs ?? config.agent?.maxTurnTimeoutMs ?? 480000,
          onProgress: options.onProgress,
          progressMs: options.progressMs,
          startedAt,
        })
      : null;

  let text;
  let usage;
  let metrics;

  if (streamed) {
    text = streamed.text;
    usage = streamed.usage;
    metrics = { ...streamed.metrics, via: "api" };
  } else {
    const payload = await response.json();
    text = payload?.choices?.[0]?.message?.content;
    usage = payload?.usage ?? null;
    metrics = {
      firstTokenMs: Date.now() - startedAt,
      totalMs: Date.now() - startedAt,
      outChars: typeof text === "string" ? text.length : 0,
      via: "api",
    };
  }

  if (!text) throw new LlmError("The model returned an empty response");

  return {
    text,
    json: parseModelJson(text),
    usage,
    metrics,
  };
}

/**
 * Universal dispatcher for direct API calls.
 */
export async function dispatchCustomApi(messages, options = {}) {
  const provider = detectApiProvider(options.baseUrl);
  if (provider === "gemini") {
    return geminiChatJson(messages, options);
  }
  if (provider === "anthropic") {
    return anthropicChatJson(messages, options);
  }
  return chatJson(messages, options);
}
