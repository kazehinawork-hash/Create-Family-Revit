const NON_CHAT_MODEL =
  /(embedding|whisper|tts|dall-e|moderation|transcribe|imagen|image|veo|lyria|aqa|native-audio|audio-preview|realtime|computer-use|robotics|deep-research|guard|deprecated|retired)/i;

/** Accept a base URL or a full chat endpoint and return the root used for /models. */
export function normalizeModelBaseUrl(raw) {
  let url = String(raw || "").trim().replace(/\/+$/, "");
  if (!url) return url;
  url = url.replace(/\/(chat\/completions|completions|messages|responses)$/i, "");
  url = url.replace(/\/models$/i, "");
  return url.replace(/\/+$/, "");
}


function normalizeId(provider, item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  if (provider === "gemini") {
    return String(item.name || "").replace(/^models\//, "");
  }
  return String(item.id || item.name || "");
}

/**
 * Turn the different `/models` response shapes into one sorted id list.
 * Gemini filters by supportedGenerationMethods; OpenAI-compatible and Anthropic
 * both expose `data`, but some proxies use `models`.
 */
export function extractModelIds(provider, payload, limit = 200) {
  const list =
    provider === "gemini"
      ? payload?.models
      : Array.isArray(payload?.data)
        ? payload.data
        : payload?.models;
  if (!Array.isArray(list)) return [];

  const ids = [];
  for (const item of list) {
    if (provider === "gemini" && Array.isArray(item?.supportedGenerationMethods)) {
      if (!item.supportedGenerationMethods.includes("generateContent")) continue;
    }
    const id = normalizeId(provider, item).trim();
    if (!id || NON_CHAT_MODEL.test(id)) continue;
    ids.push(id);
  }

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, limit);
}
