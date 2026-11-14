import { describe, expect, it } from "vitest";

import {
  analyzeKeyOrInput,
  COMMAND_CODE_BASE_URL,
  filterModels,
  groupModels,
  isApiReady,
  isModelId,
  normalizeEndpointUrl,
  pickAutoModel,
  resolveModelName,
  resolveProviderKey,
  shouldAutoCollapse,
  shouldVerify,
  suggestedModelsFor,
  verifiedKeyFor,
} from "./api-key";

describe("analyzeKeyOrInput", () => {
  it("recognises a Command Code key by its user_ prefix", () => {
    const info = analyzeKeyOrInput("user_abc123");

    expect(info.provider).toBe("openai");
    expect(info.label).toBe("Command Code API");
    expect(info.defaultBaseUrl).toBe(COMMAND_CODE_BASE_URL);
  });

  it("recognises the Command Code endpoint even without a key", () => {
    const info = analyzeKeyOrInput("", "https://api.commandcode.ai/provider/v1/models");

    expect(info.label).toBe("Command Code API");
  });

  it("keeps the classic providers unchanged", () => {
    expect(analyzeKeyOrInput("AIzaSyTEST").label).toBe("Google Gemini API");
    expect(analyzeKeyOrInput("sk-ant-123").label).toBe("Anthropic Claude API");
    expect(analyzeKeyOrInput("sk-proj-123").label).toBe("OpenAI API");
  });
});

describe("normalizeEndpointUrl", () => {
  it("strips trailing slashes and pasted route suffixes", () => {
    const root = "https://api.commandcode.ai/provider/v1";

    expect(normalizeEndpointUrl(`${root}/`)).toBe(root);
    expect(normalizeEndpointUrl(`${root}/models`)).toBe(root);
    expect(normalizeEndpointUrl(`${root}/chat/completions`)).toBe(root);
    expect(normalizeEndpointUrl(`${root}/completions`)).toBe(root);
    expect(normalizeEndpointUrl(`${root}/messages`)).toBe(root);
    expect(normalizeEndpointUrl(`${root}/responses`)).toBe(root);
    expect(normalizeEndpointUrl("  https://api.openai.com/v1/models/  ")).toBe(
      "https://api.openai.com/v1",
    );
  });
});

describe("resolveProviderKey", () => {
  it("uses a lone user_ key as the provider key and remembers it for the CLI", () => {
    const result = resolveProviderKey(["user_abc"], "");

    expect(result.providerKey).toBe("user_abc");
    expect(result.cliKey).toBe("user_abc");
    expect(result.usesCommandCode).toBe(true);
  });

  it("uses the Command Code key when the endpoint points at Command Code", () => {
    const result = resolveProviderKey(["sk-openai", "user_abc"], COMMAND_CODE_BASE_URL);

    expect(result.providerKey).toBe("user_abc");
    expect(result.cliKey).toBe("user_abc");
  });

  it("prefers the classic key on a non-Command Code endpoint", () => {
    const result = resolveProviderKey(["sk-openai", "user_abc"], "https://api.openai.com/v1");

    expect(result.providerKey).toBe("sk-openai");
    expect(result.cliKey).toBe("user_abc");
    expect(result.usesCommandCode).toBe(false);
  });

  it("has no provider key for a Command Code key alone on an unrelated endpoint", () => {
    const result = resolveProviderKey(["user_abc"], "https://api.openai.com/v1");

    expect(result.providerKey).toBe("user_abc");
  });
});

describe("isModelId", () => {
  it("rejects display names and accepts ids", () => {
    expect(isModelId("Gemini 3.8 Flash")).toBe(false);
    expect(isModelId("deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(isModelId("  ")).toBe(false);
  });
});

describe("resolveModelName", () => {
  const models = ["google/gemini-3.8-flash", "deepseek/deepseek-v4-flash"];
  const names = {
    "google/gemini-3.8-flash": "Gemini 3.8 Flash",
    "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  };

  it("maps a display name back to its id, ignoring case", () => {
    expect(resolveModelName(models, names, "gemini 3.8 FLASH")).toBe("google/gemini-3.8-flash");
  });

  it("accepts an id as-is", () => {
    expect(resolveModelName(models, names, "deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("returns null when nothing matches", () => {
    expect(resolveModelName(models, names, "Gemini 9 Ultra")).toBeNull();
    expect(resolveModelName(models, names, "")).toBeNull();
  });
});

describe("groupModels", () => {
  it("groups by the prefix before the slash and labels entries with names", () => {
    const groups = groupModels(
      ["deepseek/deepseek-v4-flash", "google/gemini-3.8-flash", "gpt-5.4-mini"],
      { "google/gemini-3.8-flash": "Gemini 3.8 Flash" },
    );

    expect(Object.keys(groups)).toEqual(["deepseek", "google", "Khác"]);
    expect(groups.google[0]).toEqual({ id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" });
    expect(groups["Khác"][0].label).toBe("gpt-5.4-mini");
  });
});

describe("filterModels", () => {
  const entries = [
    { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  ];

  it("matches the id or the display name, ignoring case", () => {
    expect(filterModels(entries, "gemini").map((entry) => entry.id)).toEqual([
      "google/gemini-3.8-flash",
    ]);
    expect(filterModels(entries, "V4 FLASH").map((entry) => entry.id)).toEqual([
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("keeps everything for an empty query", () => {
    expect(filterModels(entries, "  ")).toHaveLength(2);
  });
});

describe("pickAutoModel", () => {
  const models = ["google/gemini-3.8-flash", "gpt-5.4-mini", "deepseek/deepseek-v4-flash"];

  it("keeps a saved model that is still listed", () => {
    expect(pickAutoModel({ models, saved: "gpt-5.4-mini" })).toBe("gpt-5.4-mini");
  });

  it("falls back to the first suggested model that exists", () => {
    expect(
      pickAutoModel({
        models,
        saved: "gone/model",
        suggestions: ["not-there", "deepseek/deepseek-v4-flash"],
      }),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("falls back to the first model when nothing is suggested", () => {
    expect(pickAutoModel({ models, saved: "" })).toBe("google/gemini-3.8-flash");
  });

  it("returns an empty string for an empty catalog", () => {
    expect(pickAutoModel({ models: [] })).toBe("");
  });
});

describe("suggestedModelsFor", () => {
  it("uses the Command Code list for its label and the provider list otherwise", () => {
    expect(suggestedModelsFor("Command Code API", "openai")[0]).toBe("deepseek/deepseek-v4-flash");
    expect(suggestedModelsFor("OpenAI API", "openai")[0]).toBe("gpt-4o");
  });
});

describe("shouldVerify", () => {
  const base = "https://api.commandcode.ai/provider/v1";

  it("does not verify the pair that already succeeded", () => {
    expect(
      shouldVerify({ key: "user_abc", baseUrl: base, verifiedFor: verifiedKeyFor("user_abc", base) }),
    ).toBe(false);
  });

  it("verifies when the key or the endpoint changes", () => {
    const verifiedFor = verifiedKeyFor("user_abc", base);
    expect(shouldVerify({ key: "user_other", baseUrl: base, verifiedFor })).toBe(true);
    expect(shouldVerify({ key: "user_abc", baseUrl: "https://api.openai.com/v1", verifiedFor })).toBe(
      true,
    );
  });

  it("never verifies an empty key", () => {
    expect(shouldVerify({ key: "   ", baseUrl: base, verifiedFor: "" })).toBe(false);
  });
});

describe("isApiReady", () => {
  it("stays ready while an already verified key is re-checked", () => {
    expect(isApiReady({ state: "ok", revalidating: true })).toBe(true);
    expect(isApiReady({ state: "ok" })).toBe(true);
  });

  it("is not ready on the first check, an error, or no status", () => {
    expect(isApiReady({ state: "checking" })).toBe(false);
    expect(isApiReady({ state: "checking", revalidating: false })).toBe(false);
    expect(isApiReady({ state: "error" })).toBe(false);
    expect(isApiReady({ state: "idle" })).toBe(false);
    expect(isApiReady(null)).toBe(false);
  });
});

describe("shouldAutoCollapse", () => {
  it("collapses after picking a model once the key works", () => {
    expect(shouldAutoCollapse({ reason: "picked", focusInside: false, statusOk: true })).toBe(true);
  });

  it("collapses only for the first success of a brand-new key", () => {
    expect(
      shouldAutoCollapse({ reason: "verified-new-key", focusInside: false, statusOk: true }),
    ).toBe(true);
    expect(shouldAutoCollapse({ reason: "verified", focusInside: false, statusOk: true })).toBe(false);
  });

  it("never collapses while the focus is inside the panel", () => {
    expect(shouldAutoCollapse({ reason: "picked", focusInside: true, statusOk: true })).toBe(false);
    expect(
      shouldAutoCollapse({ reason: "verified-new-key", focusInside: true, statusOk: true }),
    ).toBe(false);
  });

  it("never collapses without a working key", () => {
    expect(shouldAutoCollapse({ reason: "picked", focusInside: false, statusOk: false })).toBe(false);
    expect(
      shouldAutoCollapse({ reason: "verified-new-key", focusInside: false, statusOk: false }),
    ).toBe(false);
  });
});
