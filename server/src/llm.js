
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

function noJsonError(text) {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
  const error = new LlmError(
    `The model replied with text instead of a JSON spec: "${preview}${preview.length >= 120 ? "…" : ""}"`,
  );
  error.text = text;
  return error;
}

export function parseModelJson(text) {
  let clean = stripFences(text);

  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw noJsonError(text);
  }

  clean = clean.slice(firstBrace, lastBrace + 1);

  // 1. Try direct parse
  try {
    return JSON.parse(clean);
  } catch (err1) {
    // 2. Try jsonrepair on the full cleaned string
    try {
      const repaired = jsonrepair(clean);
      return JSON.parse(repaired);
    } catch {
      /* continue to advanced repairing */
    }

    // 3. Clean unescaped quotes or common LLM syntax corruptions inside expressions
    let sanitized = clean
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/:\s*"([^"]*)"([^",}\]]+)"/g, ':"$1 $2"');

    try {
      return JSON.parse(jsonrepair(sanitized));
    } catch {
      const openBraces = (sanitized.match(/\{/g) || []).length;
      const closeBraces = (sanitized.match(/\}/g) || []).length;
      const openBrackets = (sanitized.match(/\[/g) || []).length;
      const closeBrackets = (sanitized.match(/\]/g) || []).length;

      if (openBrackets > closeBrackets) {
        sanitized += "]".repeat(openBrackets - closeBrackets);
      }
      if (openBraces > closeBraces) {
        sanitized += "}".repeat(openBraces - closeBraces);
      }

      try {
        return JSON.parse(jsonrepair(sanitized));
      } catch (err3) {
        const error = new LlmError(`Model returned unparseable JSON: ${err3.message}`);
        error.raw = text;
        error.sanitized = sanitized;
        throw error;
      }
    }
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
    return { type: "json_schema", json_schema: { name: "family_spec", strict: false, schema } };
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

  const contents = conversation.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

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

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new LlmError(`Gemini API error (${res.status}): ${errText.slice(0, 500)}`, res.status);
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

  const formattedMessages = conversation.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const body = {
    model,
    messages: formattedMessages,
    max_tokens: options.maxTokens ?? 8192,
    temperature: options.temperature ?? 0.2,
  };

  if (systemMessage) {
    body.system = systemMessage.content + "\n\nCRITICAL: Respond ONLY in valid JSON.";
  }

  const res = await fetch(endpoint, {
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
    throw new LlmError(`Anthropic API error (${res.status}): ${errText.slice(0, 500)}`, res.status);
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
export async function chatJson(messages, options = {}) {
  const apiKey = options.apiKey || config.llm.apiKey;
  const baseUrl = (options.baseUrl || config.llm.baseUrl).replace(/\/+$/, "");
  const model = normalizeModelId(options.model, "openai");

  if (!apiKey && !baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
    throw new LlmError(
      "API Key is missing for OpenAI-compatible endpoint. Please provide an API Key.",
    );
  }

  const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages,
    temperature: options.temperature ?? config.llm.temperature,
    max_tokens: options.maxTokens ?? config.llm.maxTokens,
    response_format: responseFormat(),
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
    });
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
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
      });
    } catch (error) {
      throw new LlmError(`Could not reach the model endpoint: ${error.message}`);
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LlmError(
      `Model request failed (${response.status}): ${detail.slice(0, 600) || response.statusText}`,
      response.status,
    );
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("The model returned an empty response");

  return {
    text: content,
    json: parseModelJson(content),
    usage: payload.usage ?? null,
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
