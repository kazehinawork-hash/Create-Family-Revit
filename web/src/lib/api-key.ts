/**
 * Direct-API key/endpoint helpers. Kept out of the component so they can be tested
 * without a browser.
 */

export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";

export interface KeyAnalysis {
  provider: string;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

/** Endpoint roots only: strip a trailing slash and any pasted route suffix. */
export function normalizeEndpointUrl(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(models|chat\/completions|completions|messages|responses)$/i, "")
    .replace(/\/+$/, "");
}

/**
 * Tự động nhận diện loại API và model mặc định từ API Key hoặc chuỗi nhập.
 */
export function analyzeKeyOrInput(keyInput: string, baseUrl = ""): KeyAnalysis {
  const trimmed = (keyInput || "").trim();
  const endpoint = String(baseUrl || "").toLowerCase();

  // 0. Command Code: key `user_…` hoặc endpoint commandcode.ai. Đứng trước nhánh
  // OpenAI-compatible chung vì Command Code dùng chính wire đó.
  if (
    trimmed.startsWith("user_") ||
    endpoint.includes("commandcode.ai") ||
    trimmed.toLowerCase().includes("commandcode.ai")
  ) {
    return {
      provider: "openai",
      label: "Command Code API",
      defaultBaseUrl: COMMAND_CODE_BASE_URL,
      defaultModel: "",
    };
  }

  // 1. Google Gemini API: thường bắt đầu bằng AIzaSy...
  if (trimmed.startsWith("AIzaSy") || trimmed.includes("AIza")) {
    return {
      provider: "gemini",
      label: "Google Gemini API",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-2.5-flash",
    };
  }

  // 2. Anthropic API: thường bắt đầu bằng sk-ant-...
  if (trimmed.startsWith("sk-ant-")) {
    return {
      provider: "anthropic",
      label: "Anthropic Claude API",
      defaultBaseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-3-7-sonnet-latest",
    };
  }

  // 3. OpenRouter: thường bắt đầu bằng sk-or-...
  if (trimmed.startsWith("sk-or-")) {
    return {
      provider: "openai",
      label: "OpenRouter API",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-3.7-sonnet",
    };
  }

  // 4. Groq, xAI, Perplexity: OpenAI-compatible providers with distinct prefixes.
  if (trimmed.startsWith("gsk_")) {
    return {
      provider: "openai",
      label: "Groq API",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "llama-3.3-70b-versatile",
    };
  }

  if (trimmed.startsWith("xai-")) {
    return {
      provider: "openai",
      label: "xAI API",
      defaultBaseUrl: "https://api.x.ai/v1",
      defaultModel: "grok-4",
    };
  }

  if (trimmed.startsWith("pplx-")) {
    return {
      provider: "openai",
      label: "Perplexity API",
      defaultBaseUrl: "https://api.perplexity.ai",
      defaultModel: "sonar",
    };
  }

  // 5. DeepSeek: sk-… 34 ký tự
  if (trimmed.startsWith("sk-") && trimmed.length === 34) {
    return {
      provider: "openai",
      label: "DeepSeek API",
      defaultBaseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
    };
  }

  // 6. OpenAI hoặc chuẩn tương thích
  if (trimmed.startsWith("sk-proj-") || trimmed.startsWith("sk-")) {
    return {
      provider: "openai",
      label: "OpenAI API",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
    };
  }

  // Nếu người dùng dán URL vào
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const lower = trimmed.toLowerCase();
    if (lower.includes("googleapis.com")) {
      return {
        provider: "gemini",
        label: "Google Gemini API",
        defaultBaseUrl: trimmed,
        defaultModel: "gemini-2.5-flash",
      };
    }
    if (lower.includes("anthropic.com")) {
      return {
        provider: "anthropic",
        label: "Anthropic Claude API",
        defaultBaseUrl: trimmed,
        defaultModel: "claude-3-7-sonnet-latest",
      };
    }
    return {
      provider: "openai",
      label: "OpenAI-compatible Endpoint",
      defaultBaseUrl: trimmed,
      defaultModel: "gpt-4o",
    };
  }

  // Mặc định là Google Gemini nếu chưa nhập
  return {
    provider: "gemini",
    label: "Tự động nhận diện",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
  };
}

/**
 * Which pasted key is the Direct API key, and which one is remembered for the CLI.
 * A `user_…` Command Code key doubles as the provider key when the endpoint points at
 * Command Code or when it is the only key pasted.
 */
export function resolveProviderKey(
  keys: string[],
  baseUrl = "",
): { providerKey: string; cliKey: string; usesCommandCode: boolean } {
  const isClassicProviderKey = (key: string) => /^(AIza|sk-)/i.test(key);

  const classicKey = keys.find(isClassicProviderKey) ?? "";
  const commandKey = keys.find((key) => key.startsWith("user_")) ?? "";
  const endpointIsCommandCode = /commandcode\.ai/i.test(baseUrl ?? "");

  const usesCommandCode = Boolean(commandKey) && (!classicKey || endpointIsCommandCode);
  const providerKey = usesCommandCode ? commandKey : classicKey;

  return {
    providerKey,
    cliKey: commandKey || keys.find((key) => !isClassicProviderKey(key)) || "",
    usesCommandCode,
  };
}

/** A real model id never contains spaces; display names ("Gemini 3.8 Flash") do. */
export function isModelId(value: string): boolean {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 && !/\s/.test(trimmed);
}

/**
 * Map a display name back to its model id ("Gemini 3.8 Flash" → "google/…"). The
 * comparison ignores case and surrounding spaces.
 */
export function resolveModelName(
  models: string[],
  names: Record<string, string> = {},
  input = "",
): string | null {
  const wanted = String(input ?? "").trim().toLowerCase();
  if (!wanted) return null;

  for (const id of models) {
    if (String(names[id] ?? "").trim().toLowerCase() === wanted) return id;
  }

  return models.find((id) => id.toLowerCase() === wanted) ?? null;
}

/** Curated models per provider family, best first. */
export const SUGGESTED_MODELS: Record<string, string[]> = {
  commandcode: ["deepseek/deepseek-v4-flash", "google/gemini-3.8-flash", "gpt-5.4-mini"],
  openai: ["gpt-4o", "gpt-4o-mini"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
  anthropic: ["claude-3-7-sonnet-latest"],
};

/** Suggestions for the detected provider (Command Code keys still report "openai"). */
export function suggestedModelsFor(label: string, provider: string): string[] {
  if (/command\s*code/i.test(label)) return SUGGESTED_MODELS.commandcode;
  return SUGGESTED_MODELS[provider] ?? [];
}

export interface ModelEntry {
  id: string;
  label: string;
}

/** Group ids by the prefix before "/" (`deepseek/...` → "deepseek"); no slash → "Khác". */
export function groupModels(models: string[], names: Record<string, string> = {}): Record<string, ModelEntry[]> {
  const groups: Record<string, ModelEntry[]> = {};

  for (const id of models) {
    const slash = id.indexOf("/");
    const group = slash > 0 ? id.slice(0, slash) : "Khác";
    (groups[group] ??= []).push({ id, label: names[id]?.trim() || id });
  }

  return Object.fromEntries(
    Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Case-insensitive filter over id and display name. */
export function filterModels(entries: ModelEntry[], query: string): ModelEntry[] {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter(
    (entry) =>
      entry.id.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle),
  );
}

/**
 * Keep the saved model when the scan still lists it, otherwise the first suggested
 * model that exists, otherwise the first model. Never invents an id.
 */
export function pickAutoModel({
  models,
  saved = "",
  suggestions = [],
}: {
  models: string[];
  saved?: string;
  suggestions?: string[];
}): string {
  if (saved && models.includes(saved)) return saved;

  for (const suggestion of suggestions) {
    if (models.includes(suggestion)) return suggestion;
  }

  return models[0] ?? "";
}

export interface ApiStatusLike {
  state: "idle" | "checking" | "ok" | "error";
  revalidating?: boolean;
}

/** `key|baseUrl` of the last successful verification. */
export function verifiedKeyFor(key: string, baseUrl: string): string {
  return `${String(key ?? "").trim()}|${String(baseUrl ?? "")}`;
}

/**
 * A verification is needed only when the key is present and the pair (key, endpoint)
 * is not the one already verified. This is what stops a re-render from re-fetching.
 */
export function shouldVerify({
  key,
  baseUrl,
  verifiedFor = "",
}: {
  key: string;
  baseUrl: string;
  verifiedFor?: string | null;
}): boolean {
  if (!String(key ?? "").trim()) return false;
  return verifiedKeyFor(key, baseUrl) !== (verifiedFor ?? "");
}

/**
 * True when the model may run: a verified key still counts while it is being
 * re-checked, but a first "checking" (nothing verified yet) does not.
 */
export function isApiReady(status: ApiStatusLike | null | undefined): boolean {
  if (!status) return false;
  if (status.state === "ok") return true;
  return status.state === "checking" && Boolean(status.revalidating);
}

/**
 * Collapsing is explicit, never timed: the "Thu gọn" button, picking a model, or
 * the first success of a brand-new key may collapse the panel. Never while the
 * keyboard focus is inside it, never without a working key.
 */
export function shouldAutoCollapse({
  reason,
  focusInside,
  statusOk,
}: {
  reason: "picked" | "verified-new-key" | "verified";
  focusInside: boolean;
  statusOk: boolean;
}): boolean {
  if (!statusOk) return false;
  if (focusInside) return false;
  return reason === "picked" || reason === "verified-new-key";
}
