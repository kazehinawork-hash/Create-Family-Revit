import assert from "node:assert/strict";
import test from "node:test";
import { extractModelIds, normalizeModelBaseUrl } from "../src/model-list.js";

test("extracts chat models from an OpenAI-compatible /models payload", () => {
  const ids = extractModelIds("openai", {
    data: [
      { id: "gpt-4o" },
      { id: "text-embedding-3-small" },
      { id: "gpt-4o-mini" },
      { id: "whisper-1" },
    ],
  });
  assert.deepEqual(ids, ["gpt-4o", "gpt-4o-mini"]);
});

test("extracts Gemini models that support generateContent", () => {
  const ids = extractModelIds("gemini", {
    models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
    ],
  });
  assert.deepEqual(ids, ["gemini-2.5-flash", "gemini-2.5-pro"]);
});

test("extracts Anthropic models and avoids duplicates", () => {
  const ids = extractModelIds("anthropic", {
    data: [{ id: "claude-sonnet-4" }, { id: "claude-sonnet-4" }, { id: "claude-opus-4" }],
  });
  assert.deepEqual(ids, ["claude-opus-4", "claude-sonnet-4"]);
});

test("returns an empty list for unrecognised payloads", () => {
  assert.deepEqual(extractModelIds("openai", null), []);
  assert.deepEqual(extractModelIds("openai", { data: "nope" }), []);
});

test("normalizes full chat URLs back to the model-catalog root", () => {
  assert.equal(
    normalizeModelBaseUrl("https://api.openai.com/v1/chat/completions"),
    "https://api.openai.com/v1",
  );
  assert.equal(
    normalizeModelBaseUrl("https://api.anthropic.com/v1/messages"),
    "https://api.anthropic.com/v1",
  );
  assert.equal(
    normalizeModelBaseUrl("https://openrouter.ai/api/v1/models"),
    "https://openrouter.ai/api/v1",
  );
  assert.equal(normalizeModelBaseUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1");
});
