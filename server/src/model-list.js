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
 * Turn the different `/models` response shapes into one sorted id list plus the
 * display names. Gemini filters by supportedGenerationMethods; OpenAI-compatible and
 * Anthropic both expose `data`, but some proxies use `models`.
 *
 * A catalog entry may declare `supported_endpoints` (Command Code does). The app talks
 * to it over the OpenAI wire, so a model that only lists `/messages` (claude-*) cannot
 * be used here and is dropped.
 */
export function extractModelCatalog(provider, payload, limit = 200) {
  const list =
    provider === "gemini"
      ? payload?.models
      : Array.isArray(payload?.data)
        ? payload.data
        : payload?.models;
  if (!Array.isArray(list)) return { models: [], names: {} };

  const models = [];
  const names = {};

  for (const item of list) {
    if (provider === "gemini" && Array.isArray(item?.supportedGenerationMethods)) {
      if (!item.supportedGenerationMethods.includes("generateContent")) continue;
    }
    if (Array.isArray(item?.supported_endpoints)) {
      if (!item.supported_endpoints.includes("/chat/completions")) continue;
    }
    const id = normalizeId(provider, item).trim();
    if (!id || NON_CHAT_MODEL.test(id)) continue;
    models.push(id);

    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (name && name !== id) names[id] = name;
  }

  const unique = [...new Set(models)].sort((a, b) => a.localeCompare(b)).slice(0, limit);
  return { models: unique, names };
}

export function extractModelIds(provider, payload, limit = 200) {
  return extractModelCatalog(provider, payload, limit).models;
}

/** Display names for the models the catalog keeps: `{ [id]: name }`. */
export function extractModelNames(provider, payload) {
  return extractModelCatalog(provider, payload).names;
}
