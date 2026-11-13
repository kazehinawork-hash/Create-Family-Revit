import assert from "node:assert/strict";
import test from "node:test";

import { isModelLocked, modelCandidates } from "../src/agents.js";
import { LlmError } from "../src/llm.js";
import {
  describeProviderError,
  isPermanentError,
  isTransientError,
  retryDelays,
  runWithModelFallback,
  withProviderRetry,
} from "../src/retry.js";

function providerError(status, detail = "This model is currently experiencing high demand") {
  return new LlmError(`Gemini API error (${status}): ${detail}`, status);
}

/** Never wait for real: record the delays instead. */
function fakeSleep(waits) {
  return async (ms) => {
    waits.push(ms);
  };
}

test("retryDelays follows the 2 s / 5 s / 12 s schedule", () => {
  assert.deepEqual(retryDelays({ retryMax: 3, baseMs: 2000, jitter: () => 0 }), [2000, 5000, 12000]);
});

test("classifies transient, permanent and local-timeout errors", () => {
  assert.equal(isTransientError(providerError(503)), true);
  assert.equal(isTransientError(providerError(429)), true);
  assert.equal(isTransientError(new LlmError("socket hang up")), true);
  assert.equal(isTransientError(providerError(401)), false);
  assert.equal(isTransientError(providerError(400)), false);
  assert.equal(isPermanentError(providerError(403)), true);
  assert.equal(isTransientError(new LlmError("Agent run timed out after 240s")), false);
  assert.equal(isTransientError(new LlmError("Agent run was cancelled")), false);
});

test("503 twice then success: three attempts, waits 2 s then 5 s", async () => {
  const waits = [];
  let calls = 0;

  const result = await runWithModelFallback({
    models: ["deepseek/deepseek-v4"],
    retryMax: 3,
    baseMs: 2000,
    jitter: () => 0,
    sleep: fakeSleep(waits),
    run: async () => {
      calls += 1;
      if (calls <= 2) throw providerError(503);
      return { json: { name: "ok" }, text: "{}", usage: null };
    },
    logger: { warn() {} },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 5000]);
  assert.equal(result.json.name, "ok");
  assert.equal(result.usedModel, "deepseek/deepseek-v4");
});

test("503 forever: falls back to the next model, then reports concisely", async () => {
  const waits = [];
  const calls = [];
  const fallbacks = [];

  await assert.rejects(
    () =>
      runWithModelFallback({
        models: ["primary-model", "fallback-model"],
        retryMax: 3,
        baseMs: 2000,
        jitter: () => 0,
        sleep: fakeSleep(waits),
        run: async (model) => {
          calls.push(model);
          throw providerError(503);
        },
        onFallback: (info) => fallbacks.push(info),
        logger: { warn() {} },
      }),
    (error) => {
      assert.match(error.message, /Nhà cung cấp model đang quá tải tạm thời \(503\)/);
      assert.match(error.message, /Đã thử lại 3 lần/);
      assert.match(error.message, /primary-model → fallback-model/);
      assert.ok(!error.message.includes("{"), "no raw JSON in the user-facing message");
      assert.match(error.detail, /high demand/, "the raw provider text stays in details");
      assert.deepEqual(error.models, ["primary-model", "fallback-model"]);
      return true;
    },
  );

  // 4 attempts per model (1 + 3 retries), 3 waits between them.
  assert.deepEqual(calls, Array(4).fill("primary-model").concat(Array(4).fill("fallback-model")));
  assert.equal(waits.length, 6);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].from, "primary-model");
  assert.equal(fallbacks[0].to, "fallback-model");
});

test("401 is not retried and does not fall back", async () => {
  const waits = [];
  const calls = [];

  await assert.rejects(
    () =>
      runWithModelFallback({
        models: ["a", "b"],
        retryMax: 3,
        baseMs: 2000,
        sleep: fakeSleep(waits),
        run: async (model) => {
          calls.push(model);
          throw providerError(401, "invalid api key");
        },
        logger: { warn() {} },
      }),
    (error) => {
      assert.match(error.message, /không thử lại được/i);
      return true;
    },
  );

  assert.deepEqual(calls, ["a"]);
  assert.deepEqual(waits, []);
});

test("lock model keeps a single candidate", () => {
  assert.deepEqual(modelCandidates("deepseek/x", ["a", "b"]), ["deepseek/x", "a", "b"]);
  assert.deepEqual(modelCandidates("deepseek/x", ["a", "b"], { lockModel: true }), ["deepseek/x"]);
  assert.deepEqual(modelCandidates("deepseek/x", ["a"], { customApiConfig: { baseUrl: "x" } }), [
    "deepseek/x",
  ]);
});

test("a model picked in the dropdown is used as-is (no silent fallback)", () => {
  assert.equal(isModelLocked({ model: "deepseek/deepseek-v4" }), true);
  assert.equal(isModelLocked({ model: "deepseek/deepseek-v4", lockModel: false }), false);
  assert.equal(isModelLocked({ model: "", lockModel: false }), false);
  assert.equal(isModelLocked({ lockModel: true }), true);
});

test("Retry-After from the provider overrides the schedule", async () => {
  const waits = [];
  let calls = 0;

  await withProviderRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        const error = providerError(429, "rate limit");
        error.retryAfterMs = 7000;
        throw error;
      }
      return "ok";
    },
    { retryMax: 3, baseMs: 2000, jitter: () => 0, sleep: fakeSleep(waits) },
  );

  assert.deepEqual(waits, [7000]);
});

test("describeProviderError is short Vietnamese, no raw payload", () => {
  const error = providerError(503, '{"error":{"code":503,"message":"high demand"}}');
  error.attempts = 4;
  const text = describeProviderError(error, { attempts: 4, models: ["a", "b"] });
  assert.equal(
    text,
    "Nhà cung cấp model đang quá tải tạm thời (503). Đã thử lại 3 lần. Đã thử 2 model dự phòng.",
  );
  assert.ok(!text.includes("{"));
});

test("an unknown model id is reported instead of a provider outage", () => {
  const error = new LlmError(
    'Agent completed without returning a spec: Error: unknown model "deepseek/deepseek-v4". Did you mean "deepseek/deepseek-v4-flash"?',
  );
  assert.equal(isTransientError(error), false);
  assert.match(
    describeProviderError(error, { attempts: 1 }),
    /Model deepseek\/deepseek-v4 không tồn tại\. Gợi ý: deepseek\/deepseek-v4-flash\./,
  );
});
