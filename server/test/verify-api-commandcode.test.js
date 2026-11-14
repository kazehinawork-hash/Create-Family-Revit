process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { app } = await import("../src/index.js");

function listen(application) {
  return new Promise((resolve) => {
    const server = http.createServer(application);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("Command Code: /models is public, so a bad key is rejected by a chat probe", async (t) => {
  const server = await listen(app);
  t.after(() => server.close());

  const { port } = server.address();
  const realFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", auth: init.headers?.Authorization });

    if (String(url).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "deepseek/deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              supported_endpoints: ["/chat/completions"],
            },
            { id: "claude-fable-5", name: "Claude Fable 5", supported_endpoints: ["/messages"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (String(url).endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  };

  try {
    const response = await realFetch(`http://127.0.0.1:${port}/api/verify-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.commandcode.ai/provider/v1",
        apiKey: "user_bad_key",
      }),
    });
    const data = await response.json();

    assert.equal(data.ok, false);
    assert.equal(data.error, "API Key Command Code không hợp lệ");

    const probe = calls.find((call) => call.url.endsWith("/chat/completions"));
    assert.ok(probe, "the key must be proven with a real chat call");
    assert.equal(probe.method, "POST");
    assert.equal(probe.auth, "Bearer user_bad_key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Command Code: a passing probe returns the chat-capable catalog with names", async (t) => {
  const server = await listen(app);
  t.after(() => server.close());

  const { port } = server.address();
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "deepseek/deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              supported_endpoints: ["/chat/completions"],
            },
            { id: "claude-fable-5", name: "Claude Fable 5", supported_endpoints: ["/messages"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (String(url).endsWith("/chat/completions")) {
      const body = JSON.parse(String(init.body ?? "{}"));
      assert.equal(body.max_tokens, 1);
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  };

  try {
    const response = await realFetch(`http://127.0.0.1:${port}/api/verify-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.commandcode.ai/provider/v1",
        apiKey: "user_good_key",
        model: "deepseek/deepseek-v4-flash",
      }),
    });
    const data = await response.json();

    assert.equal(data.ok, true);
    assert.equal(data.provider, "Command Code");
    assert.deepEqual(data.models, ["deepseek/deepseek-v4-flash"]);
    assert.equal(data.modelNames["deepseek/deepseek-v4-flash"], "DeepSeek V4 Flash");
  } finally {
    globalThis.fetch = realFetch;
  }
});
