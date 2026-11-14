import assert from "node:assert/strict";
import test from "node:test";

import { retryWholeRequest } from "../src/retry.js";

function overloaded() {
  const error = new Error("Nhà cung cấp model đang quá tải tạm thời (503)");
  error.status = 503;
  return error;
}

test("a 503 burst before any spec is retried with the configured waits", async () => {
  let runs = 0;
  const waits = [];
  const notices = [];

  const result = await retryWholeRequest(
    async () => {
      runs += 1;
      if (runs <= 2) throw overloaded();
      return { ok: true };
    },
    {
      delays: [10, 20],
      sleep: async (ms) => {
        waits.push(ms);
      },
      onWait: ({ attempt, total, delayMs }) => {
        notices.push({ attempt, total, delayMs });
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(runs, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(notices, [
    { attempt: 1, total: 2, delayMs: 10 },
    { attempt: 2, total: 2, delayMs: 20 },
  ]);
});

test("a permanent error is not retried at all", async () => {
  let runs = 0;
  const error = new Error("Invalid API key");
  error.status = 401;

  await assert.rejects(
    () =>
      retryWholeRequest(
        async () => {
          runs += 1;
          throw error;
        },
        { delays: [10, 20], sleep: async () => {} },
      ),
    /Invalid API key/,
  );

  assert.equal(runs, 1);
});

test("the retries stop when the user cancels", async () => {
  let runs = 0;
  const controller = new AbortController();
  controller.abort();
  const waits = [];

  await assert.rejects(
    () =>
      retryWholeRequest(
        async () => {
          runs += 1;
          throw overloaded();
        },
        {
          delays: [10, 20],
          signal: controller.signal,
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      ),
    /503/,
  );

  assert.equal(runs, 1);
  assert.deepEqual(waits, []);
});

test("after the last wait the provider error is reported", async () => {
  let runs = 0;
  const waits = [];

  await assert.rejects(
    () =>
      retryWholeRequest(
        async () => {
          runs += 1;
          throw overloaded();
        },
        {
          delays: [10, 20],
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      ),
    /503/,
  );

  assert.equal(runs, 3);
  assert.deepEqual(waits, [10, 20]);
});
