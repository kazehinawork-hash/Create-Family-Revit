import assert from "node:assert/strict";
import test from "node:test";

import { chatJson } from "../src/llm.js";

/** A streamed SSE body that emits one chunk per item, with a small delay between. */
function sseBody(parts, { delayMs = 5 } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

function mockFetch(body, { contentType = "text/event-stream" } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": contentType } });
  return () => {
    globalThis.fetch = original;
  };
}

test("chatJson streams SSE deltas into one JSON answer", async () => {
  const pieces = ['{"schemaVersion":"1.0",', '"name":"Thang cáp",', '"parts":[]}'];
  const chunks = pieces.map(
    (piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
  );
  chunks.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } })}\n\n`,
    "data: [DONE]\n\n",
  );

  const restore = mockFetch(sseBody(chunks, { delayMs: 30 }));
  try {
    const progress = [];
    const result = await chatJson([{ role: "user", content: "dựng thang cáp" }], {
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
      model: "deepseek-v4.1-flash",
      progressMs: 10,
      onProgress: (message) => progress.push(message),
    });

    assert.equal(result.json.schemaVersion, "1.0");
    assert.equal(result.json.name, "Thang cáp");
    assert.deepEqual(result.json.parts, []);
    assert.equal(result.usage.total_tokens, 42);
    assert.equal(result.metrics.via, "api");
    assert.ok(result.metrics.outChars > 20);
    assert.equal(result.metrics.firstTokenMs >= 0, true);
    assert.ok(progress.some((message) => message.includes("Đang viết…")), "progress is reported");
  } finally {
    restore();
  }
});

test("chatJson stops a silent stream after the idle timeout", async () => {
  // A body that never sends anything and never closes.
  const body = new ReadableStream({ start() {} });
  const restore = mockFetch(body);

  try {
    await assert.rejects(
      () =>
        chatJson([{ role: "user", content: "x" }], {
          apiKey: "sk-test",
          baseUrl: "https://example.test/v1",
          model: "deepseek-v4.1-flash",
          idleMs: 60,
          timeoutMs: 1000,
        }),
      (error) => {
        assert.match(error.message, /không gửi thêm token/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a non-streaming JSON answer is still accepted", async () => {
  const payload = JSON.stringify({
    choices: [{ message: { content: '{"schemaVersion":"1.0","parts":[]}' } }],
    usage: { total_tokens: 7 },
  });
  const restore = mockFetch(payload, { contentType: "application/json" });

  try {
    const result = await chatJson([{ role: "user", content: "x" }], {
      apiKey: "sk-test",
      baseUrl: "https://example.test/v1",
      model: "deepseek-v4.1-flash",
    });

    assert.equal(result.json.schemaVersion, "1.0");
    assert.equal(result.metrics.via, "api");
  } finally {
    restore();
  }
});
