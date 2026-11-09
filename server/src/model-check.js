import { normalizeModelBaseUrl } from "./model-list.js";

function unavailable(status, message) {
  return {
    ok: false,
    status,
    unavailable: true,
    error: message || `Model không khả dụng (${status}).`,
  };
}

/**
 * One cheap completion probe for the selected model. A catalog entry can exist
 * while the model is retired, not enabled for the key, or temporarily overloaded
 * (Gemini 503); this catches those before the user sends a full design prompt.
 */
export async function checkModel({ baseUrl, apiKey, model }) {
  const base = normalizeModelBaseUrl(baseUrl) || "https://api.openai.com/v1";
  const provider = base.toLowerCase().includes("googleapis.com")
    ? "gemini"
    : base.toLowerCase().includes("anthropic.com")
      ? "anthropic"
      : "openai";

  let endpoint;
  let headers = { "Content-Type": "application/json" };
  let body;

  if (provider === "gemini") {
    endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    body = {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    };
  } else if (provider === "anthropic") {
    endpoint = `${base}/messages`;
    headers = {
      ...headers,
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = {
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    };
  } else {
    endpoint = `${base}/chat/completions`;
    headers = { ...headers, Authorization: `Bearer ${apiKey}` };
    body = {
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    };
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    return {
      ok: false,
      error: `Không kết nối được model: ${error.message}`,
    };
  }

  if (res.ok) return { ok: true, provider };

  const status = res.status;
  const raw = await res.text().catch(() => "");

  if (status === 401 || status === 403) {
    return { ok: false, status, invalidKey: true, error: "API Key không hợp lệ hoặc không có quyền dùng model này." };
  }
  if (status === 429) {
    return { ok: false, status, rateLimited: true, error: "Model đang bị giới hạn tần suất; chưa loại khỏi danh sách." };
  }
  if (status === 400 || status === 404 || status === 422 || status === 503) {
    return unavailable(status, `Model không dùng được (${status}). ${raw.slice(0, 300)}`);
  }
  return {
    ok: false,
    status,
    error: `Không kiểm tra được model (${status}). ${raw.slice(0, 300)}`,
  };
}
