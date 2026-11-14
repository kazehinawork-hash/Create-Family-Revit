process.env.FAMILY_AGENT_NO_LISTEN = "1";

import assert from "node:assert/strict";
import test from "node:test";

import { classifyDesignError } from "../src/retry.js";

const { designOutcome } = await import("../src/index.js");

test("a clean, complete answer is 'ok'", () => {
  assert.equal(designOutcome({ ok: true }, { complete: true }), "ok");
  assert.equal(designOutcome({ ok: true }, {}), "ok");
});

test("a complete-looking answer with a missing group is 'incomplete'", () => {
  assert.equal(designOutcome({ ok: true }, { complete: false }), "incomplete");
});

test("a spec that still has errors is 'has-errors'", () => {
  assert.equal(designOutcome({ ok: false, errors: [{}] }, { complete: true }), "has-errors");
});

test("a kept old spec is 'unchanged', whatever else the stats say", () => {
  assert.equal(designOutcome({ ok: true }, { unchanged: true, complete: false }), "unchanged");
});

test("401/403 never retries and is reported as auth", () => {
  const unauthorized = Object.assign(new Error("unauthorized"), { status: 401 });
  const forbidden = Object.assign(new Error("forbidden"), { status: 403 });

  assert.equal(classifyDesignError(unauthorized), "auth");
  assert.equal(classifyDesignError(forbidden), "auth");
  assert.equal(classifyDesignError(new Error("Invalid API key")), "auth");
});

test("other failure kinds are distinguished for the advice text", () => {
  assert.equal(classifyDesignError(Object.assign(new Error("busy"), { status: 429 })), "overloaded");
  assert.equal(classifyDesignError(Object.assign(new Error("down"), { status: 503 })), "overloaded");
  assert.equal(classifyDesignError(new Error("Agent run timed out after 300s")), "timeout");

  const truncated = new Error("Model output ended before the JSON was closed (OUTPUT_LIMIT)");
  truncated.code = "OUTPUT_LIMIT";
  assert.equal(classifyDesignError(truncated), "output-limit");

  const zod = new Error("invalid");
  zod.name = "ZodError";
  assert.equal(classifyDesignError(zod), "invalid-request");

  assert.equal(classifyDesignError(new Error("socket hang up")), "network");
  assert.equal(classifyDesignError(new Error("weird")), "unknown");
});
